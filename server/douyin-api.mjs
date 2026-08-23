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
import { createDedaoClient } from './dedao-service.mjs';
import { analyzeLabel, enrichStandards } from './label-service.mjs';
import { buildPriceTrends, id, listLots, normalizeDraft, parseReceiptText, today } from './receipt-service.mjs';

const port = Number(process.env.FOODFLOW_API_PORT || 4320);
const providerUrl = process.env.DOUYIN_PROVIDER_URL || '';
const providerToken = process.env.DOUYIN_PROVIDER_TOKEN || '';
const dedaoClient = createDedaoClient({
  baseUrl: process.env.DEDAO_API_BASE || 'https://openapi.biji.com',
  apiKey: process.env.DEDAO_API_KEY || '',
  clientId: process.env.DEDAO_CLIENT_ID || '',
  pollIntervalMs: Number(process.env.DEDAO_POLL_INTERVAL_MS || 5000),
  timeoutMs: Number(process.env.DEDAO_REQUEST_TIMEOUT_MS || 15000),
  maxWaitMs: Number(process.env.DEDAO_MAX_WAIT_MS || 90000)
});
const receiptOcrUrl = process.env.RECEIPT_OCR_PROVIDER_URL || '';
const receiptOcrToken = process.env.RECEIPT_OCR_PROVIDER_TOKEN || '';
const localOcrUrl = process.env.FOODFLOW_LOCAL_OCR_URL || '';
const tencentSecretId = process.env.TENCENT_SECRET_ID || '';
const tencentSecretKey = process.env.TENCENT_SECRET_KEY || '';
const tencentOcrRegion = process.env.TENCENT_OCR_REGION || 'ap-guangzhou';
const tencentOcrConfigured = Boolean(tencentSecretId && tencentSecretKey);
const execFileAsync = promisify(execFile);
const localOcrAvailable = (() => { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const db = createDatabase();
const dedaoJobs = new Map();

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
  const configuredTimeout = Number(process.env.RECEIPT_OCR_TIMEOUT_MS || 15000);
  const timeoutMs = url === localOcrUrl ? Math.max(configuredTimeout, 30000) : configuredTimeout;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload), signal: controller.signal });
    if (!response.ok) throw new Error(`provider returned ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key, value, encoding = undefined) { return crypto.createHmac('sha256', key).update(value).digest(encoding); }

async function callTencentOcr(buffer, mimeType = 'image/jpeg') {
  const service = 'ocr'; const host = 'ocr.tencentcloudapi.com'; const action = 'GeneralAccurateOCR'; const version = '2018-11-19';
  const payload = JSON.stringify({ ImageBase64: buffer.toString('base64'), IsWords: false, EnableDetectSplit: true, ConfigID: 'OCR', WordsType: '0' });
  const timestamp = Math.floor(Date.now() / 1000); const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host'; const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`;
  const credentialScope = `${date}/${service}/tc3_request`; const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmac(`TC3${tencentSecretKey}`, date); const secretService = hmac(secretDate, service); const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${tencentSecretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Host: host, Authorization: authorization, 'X-TC-Action': action, 'X-TC-Version': version, 'X-TC-Timestamp': String(timestamp) };
  if (tencentOcrRegion && tencentOcrRegion !== 'ap-guangzhou') headers['X-TC-Region'] = tencentOcrRegion;
  const response = await fetch(`https://${host}/`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(30000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.Response?.Error) throw new Error(result.Response?.Error?.Message || `Tencent OCR HTTP ${response.status}`);
  const detections = result.Response?.TextDetections || []; const rawText = detections.map(item => item.DetectedText).filter(Boolean).join('\n');
  const parsed = parseReceiptText(rawText); const confidence = detections.length ? Math.round(detections.reduce((sum, item) => sum + Number(item.Confidence || 0), 0) / detections.length) : 0;
  return { ...parsed, rawText, confidence, ocrConfidence: confidence, providerResponse: result.Response };
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

function labelView(labelId, deviceId) {
  const row = db.prepare(`SELECT id, scanned_at AS scannedAt, product_name AS productName, raw_text AS rawText, report_json AS reportJson, ocr_confidence AS ocrConfidence FROM label_scans WHERE id = ? AND device_id = ?`).get(labelId, deviceId);
  if (!row) return null;
  let report = {}; try { report = JSON.parse(row.reportJson); } catch {}
  return { id: row.id, scannedAt: row.scannedAt, productName: row.productName, rawText: row.rawText, ocrConfidence: row.ocrConfidence, report };
}

function confirmReceipt(input, deviceId) {
  const draft = normalizeDraft(input, db);
  if (!draft.items.length) throw Object.assign(new Error('至少需要一条食材明细'), { statusCode: 400 });
  const duplicate = db.prepare(`SELECT id FROM receipts WHERE device_id = ? AND purchased_at = ? AND store_name = ? AND total_cents = ? LIMIT 1`).get(deviceId, draft.purchasedAt, draft.storeName, draft.totalCents);
  if (duplicate) throw Object.assign(new Error('可能重复导入了同一张小票'), { statusCode: 409, duplicateId: duplicate.id });
  const receiptId = id('receipt');
  const insertReceipt = db.prepare(`INSERT INTO receipts(id, device_id, store_name, purchased_at, scanned_at, total_cents, currency, ocr_confidence, raw_text, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`);
  const insertItem = db.prepare(`INSERT INTO receipt_items(id, receipt_id, raw_name, canonical_name, quantity, unit, unit_price_cents, line_total_cents, confidence, manually_edited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertLot = db.prepare(`INSERT INTO pantry_lots(id, device_id, canonical_name, display_name, quantity, remaining_quantity, unit, purchased_at, source_receipt_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock')`);
  withTransaction(db, () => {
    insertReceipt.run(receiptId, deviceId, draft.storeName, draft.purchasedAt, new Date().toISOString(), draft.totalCents, draft.currency, draft.ocrConfidence, draft.rawText);
    draft.items.forEach(item => {
      insertItem.run(id('item'), receiptId, item.rawName, item.canonicalName, item.quantity, item.unit, item.unitPriceCents, item.lineTotalCents, item.confidence, item.manuallyEdited);
      if (item.canonicalName) insertLot.run(id('lot'), deviceId, item.canonicalName, item.rawName || item.canonicalName, item.quantity, item.quantity, item.unit, draft.purchasedAt, receiptId);
    });
  });
  return receiptView(receiptId, deviceId);
}

async function scanReceipt(req, res) {
  const deviceId = deviceIdFromRequest(req);
  const { fields, file } = await readMultipart(req);
  if (!file?.buffer?.length) return sendJson(res, 400, { ok: false, error: 'image_required', message: '请上传小票图片' });
  let providerResult = null; let providerName = ''; let ocrError = '';
  try {
    if (tencentOcrConfigured) { providerResult = await callTencentOcr(file.buffer, file.mimeType); providerName = 'tencent-cloud'; }
    else if (receiptOcrUrl) { providerResult = await callProvider({ imageBase64: file.buffer.toString('base64'), mimeType: file.mimeType, locale: 'zh-CN' }, receiptOcrUrl, receiptOcrToken); providerName = 'cloud'; }
    else if (localOcrUrl) { providerResult = await callProvider({ imageBase64: file.buffer.toString('base64'), mimeType: file.mimeType, locale: 'zh-CN' }, localOcrUrl, ''); providerName = 'host-tesseract'; }
    else if (localOcrAvailable) { providerResult = await runLocalReceiptOcr(file.buffer, file.mimeType); providerName = 'local-tesseract'; }
  } catch (error) { ocrError = error?.message || 'ocr_failed'; console.error(`receipt OCR failed: ${error?.name || 'Error'} ${ocrError}`); providerResult = null; providerName = ''; }
  const providerDraft = providerResult?.receipt || providerResult || {};
  const parsedProviderText = !providerDraft.items?.length && (providerDraft.rawText || providerDraft.text) ? parseReceiptText(providerDraft.rawText || providerDraft.text) : {};
  const draftInput = { ...parsedProviderText, ...providerDraft, rawText: providerDraft.rawText || providerDraft.text || parsedProviderText.rawText || '' };
  if (!Object.keys(providerDraft).length) Object.assign(draftInput, { storeName: '', purchaseDate: fields.purchaseDate || today(), items: [], confidence: 0 });
  if (!draftInput.purchasedAt && !draftInput.purchaseDate) draftInput.purchaseDate = fields.purchaseDate || today();
  const draft = normalizeDraft(draftInput, db);
  const parsedDate = draft.purchasedAt.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (parsedDate) {
    const now = new Date(); const currentYear = now.getFullYear(); const candidate = new Date(`${currentYear}-${parsedDate[2]}-${parsedDate[3]}T00:00:00Z`); const todayDate = new Date(`${currentYear}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T00:00:00Z`);
    const nearToday = Math.abs(candidate.getTime() - todayDate.getTime()) <= 14 * 24 * 60 * 60 * 1000;
    if (Number(parsedDate[1]) < currentYear - 1 && nearToday) { draft.dateWarning = `OCR 识别日期为 ${draft.purchasedAt}，但月日接近今天，可能应为 ${currentYear}-${parsedDate[2]}-${parsedDate[3]}；请确认后再保存。`; draft.purchasedAt = `${currentYear}-${parsedDate[2]}-${parsedDate[3]}`; }
  }
  draft.imageAccepted = true;
  draft.deviceId = deviceId;
  const recognized = Boolean(providerResult?.rawText || providerResult?.text || providerResult?.items?.length || providerResult?.receipt?.items?.length);
  return sendJson(res, 200, { ok: true, status: recognized ? 'needs_review' : 'needs_manual_review', provider: recognized, providerName, ocrConfigured: tencentOcrConfigured || Boolean(receiptOcrUrl) || Boolean(localOcrUrl) || localOcrAvailable, ocrError: recognized ? '' : ocrError, message: recognized ? (providerName === 'local-tesseract' ? '已使用本地 OCR 识别，请校对小票明细' : '已识别小票，请校对后确认') : ocrError ? 'OCR 服务已配置，但本次识别失败，请重试或手动补充' : 'OCR 未提取到明细，请手动补充小票内容', receipt: draft });
}

async function scanLabel(req, res) {
  const deviceId = deviceIdFromRequest(req);
  const { file } = await readMultipart(req);
  if (!file?.buffer?.length) return sendJson(res, 400, { ok: false, error: 'image_required', message: '请上传配料表图片' });
  let ocr = null; let providerName = '';
  try {
    if (tencentOcrConfigured) { ocr = await callTencentOcr(file.buffer, file.mimeType); providerName = 'tencent-cloud'; }
    else if (receiptOcrUrl) { ocr = await callProvider({ imageBase64: file.buffer.toString('base64'), mimeType: file.mimeType, locale: 'zh-CN', task: 'food-label' }, receiptOcrUrl, receiptOcrToken); providerName = 'cloud'; }
    else if (localOcrUrl) { ocr = await callProvider({ imageBase64: file.buffer.toString('base64'), mimeType: file.mimeType, locale: 'zh-CN', task: 'food-label' }, localOcrUrl, ''); providerName = 'host-tesseract'; }
    else if (localOcrAvailable) { ocr = await runLocalReceiptOcr(file.buffer, file.mimeType); providerName = 'local-tesseract'; }
  } catch (error) { console.error(`label OCR failed: ${error?.name || 'Error'} ${error?.message || ''}`); ocr = null; providerName = ''; }
  const rawText = String(ocr?.rawText || ocr?.text || ocr?.receipt?.rawText || '');
  const report = analyzeLabel(rawText);
  return sendJson(res, 200, { ok: true, status: report.confidence ? 'needs_review' : 'needs_manual_review', provider: Boolean(rawText), providerName, message: report.summary, report: { ...report, deviceId } });
}

async function scanLabelText(req, res) {
  const input = JSON.parse(await readBody(req));
  const report = analyzeLabel(String(input.rawText || ''));
  return sendJson(res, 200, { ok: true, status: report.confidence ? 'needs_review' : 'needs_manual_review', provider: false, providerName: 'manual', message: report.summary, report });
}

function startDedaoJob(source) {
  const jobId = `dedao-${crypto.randomUUID()}`;
  const job = { jobId, status: 'processing', providerName: 'dedao-brain', source, createdAt: Date.now() };
  dedaoJobs.set(jobId, job);
  void dedaoClient.resolveLink(source.url).then(result => {
    dedaoJobs.set(jobId, { ...job, ...result, status: 'completed', completedAt: Date.now() });
  }).catch(error => {
    dedaoJobs.set(jobId, { ...job, status: 'failed', error: error.code || 'dedao_failed', message: error.message || '得到大脑解析失败', completedAt: Date.now() });
  });
  setTimeout(() => dedaoJobs.delete(jobId), 15 * 60 * 1000).unref?.();
  return job;
}

function confirmLabel(input, deviceId) {
  const report = input.report || analyzeLabel(input.rawText || '');
  const labelId = id('label');
  db.prepare(`INSERT INTO label_scans(id, device_id, scanned_at, product_name, raw_text, report_json, ocr_confidence) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(labelId, deviceId, new Date().toISOString(), String(report.productName || input.productName || ''), String(report.rawText || input.rawText || ''), JSON.stringify(report), Number(report.confidence || 0));
  return labelView(labelId, deviceId);
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, providerConfigured: Boolean(providerUrl), dedaoConfigured: dedaoClient.configured, tencentOcrConfigured, receiptOcrConfigured: tencentOcrConfigured || Boolean(receiptOcrUrl) || Boolean(localOcrUrl) || localOcrAvailable, localOcrConfigured: Boolean(localOcrUrl), localOcrAvailable, dbConfigured: true });
  if (req.method === 'POST' && url.pathname === '/api/receipts/scan') return scanReceipt(req, res);
  if (req.method === 'POST' && url.pathname === '/api/labels/scan') return scanLabel(req, res);
  if (req.method === 'POST' && url.pathname === '/api/labels/scan-text') return scanLabelText(req, res);
  if (req.method === 'POST' && url.pathname === '/api/receipts/confirm') {
    const deviceId = deviceIdFromRequest(req); const result = confirmReceipt(JSON.parse(await readBody(req)), deviceId); return sendJson(res, 201, { ok: true, receipt: result });
  }
  if (req.method === 'GET' && url.pathname === '/api/receipts') {
    const deviceId = deviceIdFromRequest(req); const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)));
    const rows = db.prepare(`SELECT id FROM receipts WHERE device_id = ? ORDER BY purchased_at DESC, scanned_at DESC LIMIT ?`).all(deviceId, limit).map(row => receiptView(row.id, deviceId));
    return sendJson(res, 200, { ok: true, receipts: rows });
  }
  if (req.method === 'POST' && url.pathname === '/api/labels/confirm') {
    const result = confirmLabel(JSON.parse(await readBody(req)), deviceIdFromRequest(req));
    return sendJson(res, 201, { ok: true, label: result });
  }
  const dedaoJobMatch = url.pathname.match(/^\/api\/douyin\/parse\/status\/([^/]+)$/);
  if (req.method === 'GET' && dedaoJobMatch) {
    const job = dedaoJobs.get(dedaoJobMatch[1]);
    return job ? sendJson(res, 200, { ok: true, ...job }) : sendJson(res, 404, { ok: false, error: 'job_not_found', message: '解析任务不存在或已过期' });
  }
  if (req.method === 'GET' && url.pathname === '/api/labels') {
    const deviceId = deviceIdFromRequest(req); const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
    const labels = db.prepare(`SELECT id FROM label_scans WHERE device_id = ? ORDER BY scanned_at DESC LIMIT ?`).all(deviceId, limit).map(row => labelView(row.id, deviceId));
    return sendJson(res, 200, { ok: true, labels });
  }
  const labelMatch = url.pathname.match(/^\/api\/labels\/([^/]+)$/);
  if (req.method === 'GET' && labelMatch) {
    const label = labelView(labelMatch[1], deviceIdFromRequest(req));
    return label ? sendJson(res, 200, { ok: true, label }) : sendJson(res, 404, { ok: false, error: 'label_not_found' });
  }
  const standardMatch = url.pathname.match(/^\/api\/standards\/(.+)$/);
  if (req.method === 'GET' && standardMatch) {
    const code = decodeURIComponent(standardMatch[1]).replace(/\s+/g, ' ');
    return sendJson(res, 200, { ok: true, standard: enrichStandards([code])[0] });
  }
  if (req.method === 'GET' && url.pathname === '/api/pantry/lots') {
    return sendJson(res, 200, { ok: true, lots: listLots(db, deviceIdFromRequest(req)) });
  }
  const consumeMatch = url.pathname.match(/^\/api\/pantry\/lots\/([^/]+)\/consume$/);
  if (req.method === 'POST' && consumeMatch) {
    const deviceId = deviceIdFromRequest(req); let input = {};
    try { input = JSON.parse(await readBody(req)); } catch { input = {}; }
    const lot = db.prepare(`SELECT id, quantity, remaining_quantity AS remainingQuantity, unit, status FROM pantry_lots WHERE id = ? AND device_id = ?`).get(consumeMatch[1], deviceId);
    if (!lot) return sendJson(res, 404, { ok: false, error: 'lot_not_found', message: '库存批次不存在' });
    if (lot.status !== 'in_stock') return sendJson(res, 409, { ok: false, error: 'lot_already_consumed', message: '这批食材已经用完' });
    const remainingValue = lot.remainingQuantity ?? lot.quantity;
    const remaining = remainingValue === null || remainingValue === undefined ? null : Number(remainingValue);
    const requested = input.quantity === undefined || input.quantity === '' ? remaining : Number(input.quantity);
    if (!Number.isFinite(requested) || requested <= 0) return sendJson(res, 400, { ok: false, error: 'invalid_quantity', message: '请输入大于 0 的用量' });
    if (Number.isFinite(remaining) && requested > remaining + 1e-9) return sendJson(res, 400, { ok: false, error: 'quantity_exceeds_remaining', message: `本批次最多还剩 ${remaining}${lot.unit || ''}` });
    const nextRemaining = Number.isFinite(remaining) ? Math.max(0, Math.round((remaining - requested) * 1000) / 1000) : 0;
    const status = nextRemaining <= 1e-9 ? 'consumed' : 'in_stock';
    db.prepare(`UPDATE pantry_lots SET remaining_quantity = ?, status = ?, consumed_at = CASE WHEN ? = 'consumed' THEN ? ELSE consumed_at END WHERE id = ? AND device_id = ? AND status = 'in_stock'`).run(nextRemaining, status, status, new Date().toISOString(), consumeMatch[1], deviceId);
    return sendJson(res, 200, { ok: true, consumedQuantity: requested, remainingQuantity: nextRemaining, status });
  }
  if (req.method === 'GET' && url.pathname === '/api/price-trends') {
    const deviceId = deviceIdFromRequest(req); const trends = buildPriceTrends(db, deviceId, url.searchParams.get('ingredient') || '', url.searchParams.get('days') || 90);
    return sendJson(res, 200, { ok: true, days: Number(url.searchParams.get('days') || 90), trends });
  }
  if (req.method === 'POST' && url.pathname === '/api/douyin/parse') {
    const input = JSON.parse(await readBody(req)); const source = normalizeSource(input.source || input.link || input.shareText);
    if (!source.raw) return sendJson(res, 400, { ok: false, error: 'source_required', message: '请提供抖音链接或分享口令' });
    if (!source.isDouyin) return sendJson(res, 422, { ok: false, error: 'unsupported_source', message: '暂时只支持抖音链接或分享口令' });
    if (dedaoClient.configured) {
      if (!source.url) return sendJson(res, 422, { ok: false, error: 'dedao_url_required', message: '得到大脑需要可访问的抖音完整链接，分享口令请先展开后再粘贴' });
      return sendJson(res, 202, { ok: true, ...startDedaoJob(source) });
    }
    const providerResult = await callProvider({ source, note: input.note || '', screenshot: input.screenshot || '' });
    if (providerResult) return sendJson(res, 200, { ok: true, ...providerResult, source });
    return sendJson(res, 200, { ok: true, status: 'needs_review', source, confidence: 58, message: '已收到抖音来源，但尚未配置内容解析供应商；请在前端补充文字或截图。' });
  }
  return sendJson(res, 404, { ok: false, error: 'not_found' });
}

const server = http.createServer((req, res) => handle(req, res).catch(error => sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode === 409 ? 'duplicate_receipt' : 'request_failed', message: error.message || '请求失败', duplicateId: error.duplicateId })));
server.listen(port, () => console.log(`FoodFlow API listening on http://localhost:${port}`));

export { server, confirmReceipt };
