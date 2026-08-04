import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, withTransaction } from '../server/db.mjs';
import { buildPriceTrends, dateDiffDays, normalizeDraft, parseReceiptText } from '../server/receipt-service.mjs';

function testDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-'));
  const db = createDatabase(path.join(dir, 'foodflow.sqlite'));
  return { db, dir };
}

test('normalizes aliases, money and units', () => {
  const { db, dir } = testDb();
  const draft = normalizeDraft({ storeName: '测试', purchaseDate: '2026-08-01', total: '12.50', items: [{ name: '西红柿', quantity: '1', unit: '公斤', lineTotal: '12.50', confidence: 88 }] }, db);
  assert.equal(draft.totalCents, 1250);
  assert.equal(draft.items[0].canonicalName, '番茄');
  assert.equal(draft.items[0].unit, 'kg');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('stored days never becomes negative', () => {
  assert.equal(dateDiffDays('2026-08-01', '2026-08-04'), 3);
  assert.equal(dateDiffDays('2026-08-05', '2026-08-04'), 0);
  assert.equal(dateDiffDays(null), null);
});

test('parses common OCR receipt lines into editable draft fields', () => {
  const parsed = parseReceiptText('某某超市\n2026-08-01 18:20\n西红柿 1 kg 12.50\n鸡蛋 2 个 18.00\n合计 30.50');
  assert.equal(parsed.purchasedAt, '2026-08-01');
  assert.equal(parsed.total, '30.50');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].name, '西红柿');
  assert.equal(parsed.items[0].unit, 'kg');
});

test('price advice waits for three comparable observations', () => {
  const { db, dir } = testDb();
  const insertReceipt = db.prepare(`INSERT INTO receipts(id, device_id, store_name, purchased_at, scanned_at, total_cents, status) VALUES (?, ?, ?, ?, ?, ?, 'confirmed')`);
  const insertItem = db.prepare(`INSERT INTO receipt_items(id, receipt_id, raw_name, canonical_name, quantity, unit, unit_price_cents, line_total_cents, confidence) VALUES (?, ?, ?, '番茄', 1, 'kg', ?, ?, 90)`);
  withTransaction(db, () => {
    [['r1','2026-06-01',800],['r2','2026-07-01',1000],['r3','2026-08-01',600]].forEach(([id,date,price]) => { insertReceipt.run(id, 'device', '店', date, date, price); insertItem.run(`i-${id}`, id, '番茄', price, price); });
  });
  const [trend] = buildPriceTrends(db, 'device', '番茄', 90);
  assert.equal(trend.sampleCount, 3);
  assert.equal(trend.advice, '适合入手');
  assert.equal(trend.latestPriceCents, 600);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
