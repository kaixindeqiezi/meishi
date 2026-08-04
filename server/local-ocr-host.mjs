import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseReceiptText } from './receipt-service.mjs';

const port = Number(process.env.FOODFLOW_OCR_PORT || 4331);
const host = process.env.FOODFLOW_OCR_HOST || '127.0.0.1';
const execFileAsync = promisify(execFile);

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 16 * 1024 * 1024) reject(new Error('request too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function ocr(input) {
  if (!input.imageBase64) throw Object.assign(new Error('imageBase64 is required'), { statusCode: 400 });
  const extension = String(input.mimeType || '').includes('png') ? '.png' : String(input.mimeType || '').includes('webp') ? '.webp' : '.jpg';
  const filename = path.join(os.tmpdir(), `foodflow-host-ocr-${crypto.randomUUID()}${extension}`);
  await fs.writeFile(filename, Buffer.from(input.imageBase64, 'base64'));
  try {
    const { stdout } = await execFileAsync('tesseract', [filename, 'stdout', '-l', 'chi_sim+eng'], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    return { ok: true, ...parseReceiptText(stdout) };
  } finally { await fs.unlink(filename).catch(() => {}); }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, tesseract: true });
  if (req.method !== 'POST' || req.url !== '/ocr') return send(res, 404, { ok: false, error: 'not_found' });
  try { return send(res, 200, await ocr(JSON.parse(await readBody(req)))); }
  catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'ocr_failed' }); }
});

server.listen(port, host, () => console.log(`FoodFlow host OCR listening on http://${host}:${port}`));
