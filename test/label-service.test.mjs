import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLabel, parseLabelText } from '../server/label-service.mjs';

test('parses ingredients, nutrition, allergens, flags and standards from a label', () => {
  const raw = `全麦夹心饼干
配料表：小麦粉、白砂糖、植物油、乳粉、食用香精
营养成分表：能量 1000kJ 蛋白质 5g 脂肪 10g 饱和脂肪 3g 碳水化合物 20g 糖 8g 钠 300mg
执行标准：GB 7718-2025`;
  const parsed = parseLabelText(raw);
  assert.equal(parsed.productName, '全麦夹心饼干');
  assert.deepEqual(parsed.ingredients.slice(0, 3).map(item => item.name), ['小麦粉', '白砂糖', '植物油']);
  assert.equal(parsed.ingredients[0].emphasis, true);
  assert.equal(parsed.nutrition.energy.value, 1000);
  assert.equal(parsed.nutrition.sodium.unit, 'mg');
  assert.ok(parsed.allergens.includes('小麦'));
  assert.ok(parsed.flags.some(flag => flag.key === 'sugar'));
  assert.ok(parsed.standards.some(code => code.includes('GB 7718')));
});

test('adds official source metadata and a cautious disclaimer', () => {
  const report = analyzeLabel('配料表：水、白砂糖\n执行标准：GB 28050-2025');
  assert.equal(report.standards[0].url.includes('nhc.gov.cn'), true);
  assert.match(report.disclaimer, /不是医疗诊断/);
  assert.match(report.summary, /提取|未提取/);
});
