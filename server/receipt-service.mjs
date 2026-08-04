import crypto from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNIT_ALIASES = new Map([
  ['公斤', 'kg'], ['千克', 'kg'], ['kg', 'kg'], ['斤', 'jin'], ['克', 'g'], ['g', 'g'],
  ['毫升', 'ml'], ['ml', 'ml'], ['升', 'l'], ['l', 'l'], ['个', 'each'], ['袋', 'pack'], ['盒', 'pack']
]);
const RECEIPT_NOISE = /^(合\s*计|总\s*计|应\s*付|实\s*付|支付|金额|找\s*零|优惠|折扣|现金|微信|支付宝|收银员|小票|商品|数量|单价|欢迎光临|谢谢惠顾|码洋|会员|订单|流水)/i;

export function today() { return new Date().toISOString().slice(0, 10); }
export function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
export function moneyToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[￥¥,]/g, '').trim());
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}
export function normalizeUnit(value) { return UNIT_ALIASES.get(String(value || '').trim().toLowerCase()) || String(value || '').trim().toLowerCase() || null; }
export function normalizeName(value, db) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const row = db.prepare('SELECT canonical_name FROM ingredient_aliases WHERE alias = ?').get(raw);
  return row?.canonical_name || raw.replace(/[（(].*?[）)]/g, '').trim();
}
export function dateDiffDays(from, to = today()) {
  if (!from) return null;
  const diff = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
  return Math.max(0, diff);
}

export function parseReceiptText(rawText) {
  const lines = String(rawText || '').split(/\r?\n/).map(line => line.replace(/[|｜]/g, ' ').replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  let purchasedAt = '';
  const dateMatch = lines.join(' ').match(/(20\s*\d{2})\s*[\/.年-]\s*(\d{1,2})\s*[\/.月-]\s*(\d{1,2})/);
  if (dateMatch) purchasedAt = `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`;
  let total = null;
  for (const line of lines) {
    const totalMatch = line.match(/(?:合\s*计|总\s*计|应\s*付|实\s*付|支付|金额|amount)[^\d]{0,14}(\d{1,6}(?:[.,]\d{1,2})?)/i);
    if (totalMatch) total = totalMatch[1].replace(',', '.');
  }
  const storeName = lines.slice(0, 6).find(line => /超市|便利|商场|市场|生鲜|百货|购物|店|market|mart/i.test(line)) || '';
  const items = [];
  for (const line of lines) {
    if (RECEIPT_NOISE.test(line) || /\d{4}[\/.年-]\d{1,2}[\/.月-]\d{1,2}/.test(line)) continue;
    const priceMatches = [...line.matchAll(/(?:¥|￥)?(\d{1,6}(?:[.,]\d{1,2}))(?!\d)/g)];
    const priceMatch = priceMatches.at(-1);
    if (!priceMatch) continue;
    const beforePrice = line.slice(0, priceMatch.index).trim().replace(/(?:¥|￥)$/, '').trim();
    if (!beforePrice || /^[\d\s.,]+$/.test(beforePrice) || beforePrice.length > 50 || !/[\u4e00-\u9fffA-Za-z]/.test(beforePrice)) continue;
    let name = beforePrice, quantity = null, unit = null;
    const quantitySource = beforePrice.replace(/\s+\d{1,6}[.,]\d{1,2}\s*$/, '').trim();
    const quantityMatch = quantitySource.match(/^(.*?)\s+(\d+(?:[.,]\d+)?)\s*(kg|公斤|斤|克|g|毫升|ml|个|袋|盒|份|件)?$/i);
    if (quantityMatch && quantityMatch[1].trim().length >= 1) { name = quantityMatch[1].trim(); quantity = quantityMatch[2].replace(',', '.'); unit = quantityMatch[3] || null; }
    else {
      const numericTail = [...beforePrice.matchAll(/(\d+(?:[.,]\d+)?)(?:\s*)(kg|公斤|斤|克|g|毫升|ml|个|袋|盒|份|件)?$/i)].at(-1);
      if (numericTail && numericTail.index > 0) { name = beforePrice.slice(0, numericTail.index).trim(); quantity = numericTail[1].replace(',', '.'); unit = numericTail[2] || null; }
    }
    if (name.length < 1 || RECEIPT_NOISE.test(name)) continue;
    items.push({ name, quantity, unit, lineTotal: priceMatch[1].replace(',', '.'), confidence: priceMatches.length > 1 ? 70 : 62 });
  }
  return { rawText: lines.join('\n'), storeName, purchasedAt, total, items, confidence: items.length ? Math.max(...items.map(item => item.confidence)) : 0 };
}

export function normalizeItem(item, db, manuallyEdited = false) {
  const rawName = String(item.rawName || item.name || '').trim();
  const quantity = Number(item.quantity);
  const lineTotal = moneyToCents(item.lineTotal ?? item.total);
  const suppliedUnitPrice = moneyToCents(item.unitPrice ?? item.unit_price);
  const unit = normalizeUnit(item.unit);
  const unitPrice = suppliedUnitPrice ?? (lineTotal !== null && Number.isFinite(quantity) && quantity > 0 ? Math.round(lineTotal / quantity) : null);
  return {
    rawName,
    canonicalName: normalizeName(rawName, db),
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
    unit,
    unitPriceCents: unitPrice,
    lineTotalCents: lineTotal,
    confidence: Math.max(0, Math.min(100, Number(item.confidence ?? 0))),
    manuallyEdited: manuallyEdited ? 1 : 0
  };
}

export function normalizeDraft(input, db) {
  const items = (Array.isArray(input.items) ? input.items : []).map(item => normalizeItem(item, db, Boolean(input.manuallyEdited)));
  const suppliedTotal = input.total !== undefined && input.total !== null && input.total !== '' ? moneyToCents(input.total) : Number.isFinite(Number(input.totalCents)) ? Math.round(Number(input.totalCents)) : null;
  return {
    storeName: String(input.storeName || input.store || '').trim(),
    purchasedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(input.purchasedAt || input.purchaseDate || '')) ? String(input.purchasedAt || input.purchaseDate) : today(),
    totalCents: suppliedTotal ?? items.reduce((sum, item) => sum + (item.lineTotalCents || 0), 0),
    currency: String(input.currency || 'CNY'),
    ocrConfidence: Number(input.ocrConfidence ?? input.confidence ?? 0),
    rawText: String(input.rawText || ''),
    items
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

export function buildPriceTrends(db, deviceId, ingredient = '', days = 90) {
  const since = new Date(Date.now() - Math.max(1, Number(days) || 90) * DAY_MS).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT ri.canonical_name, ri.unit_price_cents, ri.unit, r.purchased_at, r.store_name
    FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
    WHERE r.device_id = ? AND r.status = 'confirmed' AND r.purchased_at >= ? AND ri.unit_price_cents IS NOT NULL
    ${ingredient ? 'AND ri.canonical_name = ?' : ''} ORDER BY r.purchased_at ASC`).all(...(ingredient ? [deviceId, since, ingredient] : [deviceId, since]));
  const grouped = new Map();
  rows.forEach(row => { const key = row.canonical_name; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(row); });
  return [...grouped].map(([name, observations]) => {
    const prices = observations.map(row => row.unit_price_cents);
    const latest = observations.at(-1);
    const average = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const baseline = prices.length > 1 ? Math.round(prices.slice(0, -1).reduce((a, b) => a + b, 0) / (prices.length - 1)) : average;
    const deltaPct = baseline ? Math.round(((latest.unit_price_cents - baseline) / baseline) * 1000) / 10 : 0;
    const p25 = percentile(prices, .25), p75 = percentile(prices, .75);
    let advice = '样本不足';
    if (prices.length >= 3) advice = latest.unit_price_cents <= p25 ? '适合入手' : latest.unit_price_cents >= p75 ? '近期偏贵' : '价格正常';
    return { ingredient: name, unit: latest.unit || '', sampleCount: prices.length, latestPriceCents: latest.unit_price_cents, averagePriceCents: average, minPriceCents: Math.min(...prices), p25PriceCents: p25, p75PriceCents: p75, deltaPct, advice, latestDate: latest.purchased_at, latestStore: latest.store_name };
  });
}

export function listLots(db, deviceId) {
  return db.prepare(`SELECT id, canonical_name AS ingredient, display_name AS displayName, quantity, unit, purchased_at AS purchasedAt, source_receipt_id AS sourceReceiptId, status,
    CASE WHEN purchased_at IS NULL THEN NULL ELSE MAX(0, CAST(julianday('now', 'localtime') - julianday(purchased_at) AS INTEGER)) END AS storedDays
    FROM pantry_lots WHERE device_id = ? ORDER BY status = 'in_stock' DESC, purchased_at ASC`).all(deviceId);
}
