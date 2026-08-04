import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { URL } from 'node:url';
import Busboy from 'busboy';
import { createDatabase, deviceIdFromRequest, withTransaction } from './db.mjs';
import { buildPriceTrends, id, listLots, normalizeDraft, parseReceiptText, today } from './receipt-service.mjs';

const port = Number(process.env.FOODFLOW_API_PORT || 4320);
const providerUrl = process.env.DOUYIN_PROVIDER_URL || '';
const providerToken = process.env.DOUYIN_PROVIDER_TOKEN || '';
const receiptOcrUrl = process.env.RECEIPT_OCR_PROVIDER_URL || '';
const receiptOcrToken = process.env.RECEIPT_OCR_PROVIDER_TOKEN || '';
const localOcrUrl = process.env.FOODFLOW_LOCAL_OCR_URL || '';
const execFileAsync = promisify(execFile);
const localOcrAvailable = (() => { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const db = createDatabase();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, x-device-id', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(body);
}

function normalizeSource(source = '') {
  const text = String(source).trim();
  const match = text.match(/https?:\/\/[^\s]+/i);
  const url = match ? match[0].replace(/[，。；;）)]+$/, '') : '';
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch {}
  const isDouyin = /(?:^|\.)douyin\.com$/.test(hostname) || /(?:^|\.)iesdouyin\.com$/.test(hostname) || /抖音|douyin|复制此链接/.test(text);
  return { raw: text, url, hostname, isDouyin };
}

async function callProvider(payload, url = providerUrl, token = providerToken) {
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.RECEIPT_OCR_TIMEOUT_MS || 15000));
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload), signal: controller.signal });
    if (!response.ok) throw new Error(`provider returned ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

async function runLocalReceiptOcr(buffer, mimeType = 'image/jpeg') {
  const extension = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
  const filename = path.join(os.tmpdir(), `foodflow-receipt-${crypto.randomUUID()}${extension}`);
  await fs.writeFile(filename, buffer);
  try {
    const { stdout } = await execFileAsync('tesseract', [filename, 'stdout', '-l', 'chi_sim+eng'], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    return parseReceiptText(stdout);
  } finally { await fs.unlink(filename).catch(() => {}); }
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > limit) { req.destroy(); reject(new Error('request too large')); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {}; let file = null; let tooLarge = false;
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 20 } });
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      const chunks = []; file = { field: name, mimeType: info.mimeType, filename: info.filename };
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('limit', () => { tooLarge = true; });
      stream.on('end', () => { file.buffer = Buffer.concat(chunks); });
    });
    bb.on('error', reject);
    bb.on('finish', () => tooLarge ? reject(Object.assign(new Error('image too large'), { statusCode: 413 })) : resolve({ fields, file }));
    req.pipe(bb);
  });
}

function receiptView(receiptId, deviceId) {
  const receipt = db.prepare(`SELECT id, store_name AS storeName, purchased_at AS purchasedAt, scanned_at AS scannedAt, total_cents AS totalCents, currency, ocr_confidence AS ocrConfidence, raw_text AS rawText, status FROM receipts WHERE id = ? AND device_id = ?`).get(receiptId, deviceId);
  if (!receipt) return null;
  receipt.items = db.prepare(`SELECT raw_name AS rawName, canonical_name AS canonicalName, quantity, unit, unit_price_cents AS unitPriceCents, line_total_cents AS lineTotalCents, confidence, manually_edited AS manuallyEdited FROM receipt_items WHERE receipt_id = ?`).all(receiptId);
  return receipt;
}

function confirmReceipt(input, deviceId) {
  const draft = normalizeDraft(input, db);
  if (!draft.items.length) throw Object.assign(new Error('至少需要一条食材明细'), { statusCode: 400 });
  const duplicate = db.prepare(`SELECT id FROM receipts WHERE device_id = ? AND purchased_at = ? AND store_name = ? AND total_cents = ? LIMIT 1`).get(deviceId, draft.purchasedAt, draft.storeName, draft.totalCents);
  if (duplicate) throw Object.assign(new Error('可能重复导入了同一张小票'), { statusCode: 409, duplicateId: duplicate.id });
  const receiptId = id('receipt');
  const insertReceipt = db.prepare(`INSERT INTO receipts(id, device_id, store_name, purchased_at, scanned_at, total_cents, currency, ocr_confidence, raw_text, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`);
  const insertItem = db.prepare(`INSERT INTO receipt_items(id, receipt_id, raw_name, canonical_name, quantity, unit, unit_price_cents, line_total_cents, confidence, manually_edited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertLot = db.prepare(`INSERT INTO pantry_lots(id, device_id, canonical_name, display_name, quantity, unit, purchased_at, source_receipt_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_stock')`);
  withTransaction(db, () => {
    insertReceipt.run(receiptId, deviceId, draft.storeName, draft.purchasedAt, new Date().toISOString(), draft.totalCents, draft.currency, draft.ocrConfidence, draft.rawText);
    draft.items.forEach(item => {
      insertItem.run(id('item'), receiptId, item.rawName, item.canonicalName, item.quantity, item.unit, item.unitPriceCents, item.lineTotalCents, item.confidence, item.manuallyEdited);
      if (item.canonicalName) insertLot.run(id('lot'), deviceId, item.canonicalName, item.rawName || item.canonicalName, item.quantity, item.unit, draft.purchasedAt, receiptId);
    });
  });
  return receiptView(receiptId, deviceId);
}

async function scanReceipt(req, res) {
  const deviceId = deviceIdFromRequest(req);
  const { fields, file } = await readMultipart(req);
  if (!file?.buffer?.length) return sendJson(res, 400, { ok: false, error: 'image_required', message: '请上传小票图片' });
  let providerResult = null; let providerName = '';
  try {
    if (receiptOcrUrl) { providerResult = await callProvider({ imageBase64: file.buffer.toString('base64'), mimeType: file.mimeType, locale: 'zh-CN' }, receiptOcrUrl, receiptOcrToken); providerName = 'cloud'; }
    else if (localOcrUrl) { providerResult = await callProvider({ imageBase64: file.buffer.toString('base64'), mimeType: file.mimeType, locale: 'zh-CN' }, localOcrUrl, ''); providerName = 'host-tesseract'; }
    else if (localOcrAvailable) { providerResult = await runLocalReceiptOcr(file.buffer, file.mimeType); providerName = 'local-tesseract'; }
  } catch { providerResult = null; providerName = ''; }
  const draftInput = providerResult?.receipt || providerResult || { storeName: '', purchaseDate: fields.purchaseDate || today(), items: [], confidence: 0 };
  if (!draftInput.purchasedAt && !draftInput.purchaseDate) draftInput.purchaseDate = fields.purchaseDate || today();
  const draft = normalizeDraft(draftInput, db);
  draft.imageAccepted = true;
  draft.deviceId = deviceId;
  const recognized = Boolean(providerResult?.rawText || providerResult?.items?.length || providerResult?.receipt?.items?.length);
  return sendJson(res, 200, { ok: true, status: recognized ? 'needs_review' : 'needs_manual_review', provider: recognized, providerName, message: recognized ? (providerName === 'local-tesseract' ? '已使用本地 OCR 识别，请校对小票明细' : '已识别小票，请校对后确认') : 'OCR 未提取到明细，请手动补充小票内容', receipt: draft });
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, providerConfigured: Boolean(providerUrl), receiptOcrConfigured: Boolean(receiptOcrUrl) || Boolean(localOcrUrl) || localOcrAvailable, localOcrConfigured: Boolean(localOcrUrl), localOcrAvailable, dbConfigured: true });
  if (req.method === 'POST' && url.pathname === '/api/receipts/scan') return scanReceipt(req, res);
  if (req.method === 'POST' && url.pathname === '/api/receipts/confirm') {
    const deviceId = deviceIdFromRequest(req); const result = confirmReceipt(JSON.parse(await readBody(req)), deviceId); return sendJson(res, 201, { ok: true, receipt: result });
  }
  if (req.method === 'GET' && url.pathname === '/api/receipts') {
    const deviceId = deviceIdFromRequest(req); const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)));
    const rows = db.prepare(`SELECT id FROM receipts WHERE device_id = ? ORDER BY purchased_at DESC, scanned_at DESC LIMIT ?`).all(deviceId, limit).map(row => receiptView(row.id, deviceId));
    return sendJson(res, 200, { ok: true, receipts: rows });
  }
  if (req.method === 'GET' && url.pathname === '/api/pantry/lots') {
    return sendJson(res, 200, { ok: true, lots: listLots(db, deviceIdFromRequest(req)) });
  }
  const consumeMatch = url.pathname.match(/^\/api\/pantry\/lots\/([^/]+)\/consume$/);
  if (req.method === 'POST' && consumeMatch) {
    const deviceId = deviceIdFromRequest(req); const result = db.prepare(`UPDATE pantry_lots SET status = 'consumed', consumed_at = ? WHERE id = ? AND device_id = ? AND status = 'in_stock'`).run(new Date().toISOString(), consumeMatch[1], deviceId);
    if (!result.changes) return sendJson(res, 404, { ok: false, error: 'lot_not_found' });
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/price-trends') {
    const deviceId = deviceIdFromRequest(req); const trends = buildPriceTrends(db, deviceId, url.searchParams.get('ingredient') || '', url.searchParams.get('days') || 90);
    return sendJson(res, 200, { ok: true, days: Number(url.searchParams.get('days') || 90), trends });
  }
  if (req.method === 'POST' && url.pathname === '/api/douyin/parse') {
    const input = JSON.parse(await readBody(req)); const source = normalizeSource(input.source || input.link || input.shareText);
    if (!source.raw) return sendJson(res, 400, { ok: false, error: 'source_required', message: '请提供抖音链接或分享口令' });
    if (!source.isDouyin) return sendJson(res, 422, { ok: false, error: 'unsupported_source', message: '暂时只支持抖音链接或分享口令' });
    const providerResult = await callProvider({ source, note: input.note || '', screenshot: input.screenshot || '' });
    if (providerResult) return sendJson(res, 200, { ok: true, ...providerResult, source });
    return sendJson(res, 200, { ok: true, status: 'needs_review', source, confidence: 58, message: '已收到抖音来源，但尚未配置内容解析供应商；请在前端补充文字或截图。' });
  }
  return sendJson(res, 404, { ok: false, error: 'not_found' });
}

const server = http.createServer((req, res) => handle(req, res).catch(error => sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode === 409 ? 'duplicate_receipt' : 'request_failed', message: error.message || '请求失败', duplicateId: error.duplicateId })));
server.listen(port, () => console.log(`FoodFlow API listening on http://localhost:${port}`));

export { server, confirmReceipt };
