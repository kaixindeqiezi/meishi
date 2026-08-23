import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`API exited before health check (${child.exitCode})`);
    try { const response = await fetch(`${url}/health`); if (response.ok) return response.json(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('API health check timed out');
}

test('receipt API smoke flow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-api-'));
  const port = 46000 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['server/douyin-api.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, FOODFLOW_API_PORT: String(port), FOODFLOW_DB_PATH: path.join(dir, 'foodflow.sqlite') },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'content-type': 'application/json', 'x-device-id': 'api-test-device' };
  try {
    const health = await waitForHealth(base, child);
    assert.equal(health.dbConfigured, true);
    assert.equal(health.receiptOcrConfigured, false);

    const form = new FormData();
    form.append('image', new Blob([Buffer.from('receipt')], { type: 'image/png' }), 'receipt.png');
    const scan = await fetch(`${base}/api/receipts/scan`, { method: 'POST', headers: { 'x-device-id': 'api-test-device' }, body: form });
    const scanPayload = await scan.json();
    assert.equal(scan.status, 200);
    assert.equal(scanPayload.status, 'needs_manual_review');

    const labelScan = await fetch(`${base}/api/labels/scan`, { method: 'POST', headers: { 'x-device-id': 'api-test-device' }, body: form });
    assert.equal(labelScan.status, 200);
    assert.equal((await labelScan.json()).status, 'needs_manual_review');
    const labelConfirm = await fetch(`${base}/api/labels/confirm`, { method: 'POST', headers, body: JSON.stringify({ productName: '测试食品', rawText: '配料表：小麦粉、白砂糖\n执行标准：GB 7718-2025' }) });
    assert.equal(labelConfirm.status, 201);
    const labels = await fetch(`${base}/api/labels`, { headers: { 'x-device-id': 'api-test-device' } });
    assert.equal((await labels.json()).labels.length, 1);

    const receipt = { storeName: '测试超市', purchaseDate: '2026-08-01', total: 12.5, items: [{ name: '西红柿', quantity: 1, unit: 'kg', lineTotal: 12.5, confidence: 90 }] };
    const confirm = await fetch(`${base}/api/receipts/confirm`, { method: 'POST', headers, body: JSON.stringify(receipt) });
    assert.equal(confirm.status, 201);
    const duplicate = await fetch(`${base}/api/receipts/confirm`, { method: 'POST', headers, body: JSON.stringify(receipt) });
    assert.equal(duplicate.status, 409);

    const lots = await fetch(`${base}/api/pantry/lots`, { headers: { 'x-device-id': 'api-test-device' } });
    const lotsPayload = await lots.json();
    assert.equal(lots.status, 200);
    assert.equal(lotsPayload.lots.length, 1);
    assert.ok(lotsPayload.lots[0].storedDays >= 0);
    assert.equal(lotsPayload.lots[0].remainingQuantity, 1);

    const partialConsume = await fetch(`${base}/api/pantry/lots/${lotsPayload.lots[0].id}/consume`, { method: 'POST', headers, body: JSON.stringify({ quantity: 0.4 }) });
    assert.equal(partialConsume.status, 200);
    const partialPayload = await partialConsume.json();
    assert.equal(partialPayload.remainingQuantity, 0.6);
    const lotsAfterPartial = await (await fetch(`${base}/api/pantry/lots`, { headers: { 'x-device-id': 'api-test-device' } })).json();
    assert.equal(lotsAfterPartial.lots[0].status, 'in_stock');
    assert.equal(lotsAfterPartial.lots[0].remainingQuantity, 0.6);

    const trends = await fetch(`${base}/api/price-trends`, { headers: { 'x-device-id': 'api-test-device' } });
    assert.equal(trends.status, 200);
    assert.equal((await trends.json()).trends[0].advice, '样本不足');
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
