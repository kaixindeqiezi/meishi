import http from 'node:http';
import { URL } from 'node:url';

const port = Number(process.env.FOODFLOW_API_PORT || 4320);
const providerUrl = process.env.DOUYIN_PROVIDER_URL || '';
const providerToken = process.env.DOUYIN_PROVIDER_TOKEN || '';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
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

async function callProvider(payload) {
  if (!providerUrl) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(providerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(providerToken ? { authorization: `Bearer ${providerToken}` } : {}) },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`provider returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) { req.destroy(); reject(new Error('request too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { ok: true, providerConfigured: Boolean(providerUrl) });
  if (req.method !== 'POST' || req.url !== '/api/douyin/parse') return sendJson(res, 404, { ok: false, error: 'not_found' });
  try {
    const input = JSON.parse(await readBody(req));
    const source = normalizeSource(input.source || input.link || input.shareText);
    if (!source.raw) return sendJson(res, 400, { ok: false, error: 'source_required', message: '请提供抖音链接或分享口令' });
    if (!source.isDouyin) return sendJson(res, 422, { ok: false, error: 'unsupported_source', message: '暂时只支持抖音链接或分享口令' });
    const providerResult = await callProvider({ source, note: input.note || '', screenshot: input.screenshot || '' });
    if (providerResult) return sendJson(res, 200, { ok: true, ...providerResult, source });
    return sendJson(res, 200, {
      ok: true,
      status: 'needs_review',
      source,
      confidence: 58,
      message: '接口已收到抖音来源，但尚未配置内容解析供应商；请在前端补充文字或截图。'
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: 'parse_failed', message: error.message || '解析服务暂时不可用' });
  }
});

server.listen(port, () => console.log(`FoodFlow Douyin API listening on http://localhost:${port}`));

export { server };
