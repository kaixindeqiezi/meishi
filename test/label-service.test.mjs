import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLabel, parseLabelText } from '../server/label-service.mjs';

test('scales label NRV by grams and whole package without inventing sugar NRV', () => {
  const raw = '饼干\n配料表：小麦粉、白砂糖、山梨酸钾、阿斯巴甜\n净含量：200g\n营养成分表 每100g\n脂肪 10g 17%\n饱和脂肪 3g 15%\n糖 8g\n钠 600mg 30%';
  const half = analyzeLabel(raw, {quantity:50,unit:'g'});
  assert.equal(half.portion.nutrients.sodium.nrvPercent, 15);
  assert.equal(half.portion.nutrients.sodium.value, 300);
  assert.equal(half.portion.color, 'yellow');
  assert.equal(half.nutrition.sugar.nrvPercent, null);
  assert.equal(half.nutrition.addedSugar, undefined);
  assert.equal(half.basis.netQuantity.value, 200);
  assert.equal(half.additives.find(a=>a.name === '山梨酸钾').category, '防腐剂');
  assert.match(half.additives.find(a=>a.name === '阿斯巴甜').caution, /苯丙酮尿症/);
  assert.equal(analyzeLabel(raw, {quantity:200,unit:'g'}).portion.nutrients.sodium.nrvPercent, 60);
  assert.equal(analyzeLabel(raw, {quantity:200,unit:'ml'}).portion.valid, false);
});

test('serving basis, unknown and dual columns are handled conservatively', () => {
  const raw = '营养成分表 每份（30g）\n脂肪 3g 5%\n钠 100mg 5%';
  assert.equal(analyzeLabel(raw).portion.nutrients.sodium.value, 100);
  assert.equal(analyzeLabel(raw,{quantity:60,unit:'g'}).portion.nutrients.sodium.value, 200);
  assert.equal(analyzeLabel(raw,{quantity:2,unit:'serving'}).portion.nutrients.sodium.nrvPercent, 10);
  assert.equal(analyzeLabel('营养成分表\n钠 100mg 5%').portion.valid, false);
  assert.equal(analyzeLabel('营养成分表 每100g 每份（30g）\n钠 100mg 5% 30mg 2%').portion.valid, false);
  assert.equal(analyzeLabel('营养成分表 每100ml\n蛋白质 30g 50%').portion.color, 'gray');
});

test('nutrition names do not borrow saturated fat and additive marketing is not detection', () => {
  const r = analyzeLabel('配料表：水、白砂糖、不添加苯甲酸钠\n营养成分表 每100g\n饱和脂肪酸 8g 40%\n钠（mg）600 30%\n糖（乳糖）5g\n添加糖 1g\n蛋白质 30g 50%');
  assert.equal(r.nutrition.fat, undefined);
  assert.equal(r.nutrition.sugar.value, 5);
  assert.equal(r.nutrition.addedSugar.value, 1);
  assert.equal(r.nutrition.sodium.nrvPercent, 30);
  assert.equal(r.additives.length, 0);
  assert.equal(r.portion.color, 'red');
});

test('no additive quota or green health guarantee for missing information', () => {
  const r = analyzeLabel('配料表：水、山梨酸钾');
  assert.equal(r.portion.valid, false);
  assert.match(r.additiveNote, /不能换算ADI/);
  assert.ok(r.sources.length >= 4);
});

test('recognizes NRV numeric column only when header identifies percent', () => {
  const r = analyzeLabel('配料表：水\n营养成分表 每100g NRV%\n脂肪 10g 17\n钠 600mg 30');
  assert.equal(r.nutrition.fat.nrvPercent, 17);
  assert.equal(r.nutrition.sodium.nrvPercent, 30);
  assert.equal(analyzeLabel('营养成分表 每100g\n钠 600mg 30').nutrition.sodium.nrvPercent, null);
});

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
