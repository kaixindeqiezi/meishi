import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createDatabase(filename = process.env.FOODFLOW_DB_PATH || './data/foodflow.sqlite') {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      store_name TEXT NOT NULL DEFAULT '',
      purchased_at TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      total_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'CNY',
      ocr_confidence REAL NOT NULL DEFAULT 0,
      raw_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'confirmed'
    );
    CREATE TABLE IF NOT EXISTS receipt_items (
      id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
      raw_name TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      quantity REAL,
      unit TEXT,
      unit_price_cents INTEGER,
      line_total_cents INTEGER,
      confidence REAL NOT NULL DEFAULT 0,
      manually_edited INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pantry_lots (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      quantity REAL,
      unit TEXT,
      purchased_at TEXT,
      source_receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'in_stock',
      consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ingredient_aliases (
      alias TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_device_date ON receipts(device_id, purchased_at);
    CREATE INDEX IF NOT EXISTS idx_items_canonical ON receipt_items(canonical_name);
    CREATE INDEX IF NOT EXISTS idx_lots_device_status ON pantry_lots(device_id, status);
  `);
  const aliases = [
    ['西红柿', '番茄'], ['小番茄', '番茄'], ['土豆', '马铃薯'], ['青椒', '青辣椒'],
    ['猪肉', '猪肉'], ['猪瘦肉', '猪肉'], ['鸡胸', '鸡胸肉'], ['鸡胸肉', '鸡胸肉'],
    ['鸡蛋', '鸡蛋'], ['鸡蛋（个）', '鸡蛋'], ['大葱', '葱'], ['小葱', '葱']
  ];
  const insertAlias = db.prepare('INSERT OR IGNORE INTO ingredient_aliases(alias, canonical_name) VALUES (?, ?)');
  db.exec('BEGIN');
  try { aliases.forEach(([alias, canonical]) => insertAlias.run(alias, canonical)); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  return db;
}

export function withTransaction(db, callback) {
  db.exec('BEGIN');
  try { const result = callback(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function deviceIdFromRequest(req) {
  const value = String(req.headers['x-device-id'] || '').trim();
  if (!value || value.length > 120 || !/^[a-zA-Z0-9._:-]+$/.test(value)) {
    const error = new Error('x-device-id is required');
    error.statusCode = 400;
    throw error;
  }
  return value;
}
