const STANDARD_SOURCES = {
  'GB 7718': { title: '食品安全国家标准 预包装食品标签通则', status: '已发布，按包装生产日期和实施日期判断适用性', url: 'https://www.nhc.gov.cn/sps/c100087/202509/bc824a504ec34c27883da73f14c20d44.shtml' },
  'GB 28050': { title: '食品安全国家标准 预包装食品营养标签通则', status: '2025 版将于 2027-03-16 实施', url: 'https://www.nhc.gov.cn/sps/c100087/202509/470fa4ff5de14dd38619223cce9da4e7.shtml' },
  'GB 2760': { title: '食品安全国家标准 食品添加剂使用标准', status: '按食品类别、添加剂和使用限量核对', url: 'https://www.nhc.gov.cn/sps/c100088/202403/bda120e678df4a49a8beb90852559d7c.shtml' }
};
const ALLERGENS = ['小麦', '黑麦', '大麦', '燕麦', '虾', '龙虾', '蟹', '鱼', '蛋', '花生', '大豆', '乳', '牛奶', '坚果', '杏仁', '核桃'];
const FLAG_RULES = [
  { key: 'sodium', pattern: /食盐|盐$|氯化钠|酱油|酱腌菜|咸菜|钠/i, title: '钠/盐关注', detail: '配料或营养表出现盐、钠或高盐调味相关词，建议结合营养成分表中的钠含量判断。', evidence: 'label_text' },
  { key: 'sugar', pattern: /白砂糖|蔗糖|葡萄糖浆|果葡糖浆|麦芽糖浆|玉米糖浆|糖浆|砂糖/i, title: '添加糖关注', detail: '配料表出现糖或糖浆类配料；这不是对产品的否定结论，应结合每 100g/每份糖含量和食用量判断。', evidence: 'label_text' },
  { key: 'fat', pattern: /氢化植物油|部分氢化|起酥油|人造奶油|棕榈油|椰子油/i, title: '脂肪来源关注', detail: '配料表出现需要进一步了解的油脂或氢化油描述，建议结合脂肪、饱和脂肪和反式脂肪标示判断。', evidence: 'label_text' },
  { key: 'sweetener', pattern: /阿斯巴甜|安赛蜜|三氯蔗糖|甜蜜素|糖精钠|赤藓糖醇|木糖醇|甜味剂/i, title: '甜味剂关注', detail: '配料表出现甜味剂名称；是否允许使用和限量需按食品类别核对 GB 2760 或对应产品标准。', evidence: 'GB 2760' },
  { key: 'flavor', pattern: /香精|香料|食用香精|复配香精/i, title: '香精香料提示', detail: '这表示存在风味调配成分，不等同于有害；如需判断应继续查看完整配料和产品类别。', evidence: 'label_text' },
  { key: 'caffeine', pattern: /咖啡因|咖啡提取物|茶提取物|绿茶|红茶/i, title: '咖啡因/茶来源提示', detail: '可能含有咖啡因或茶来源成分；对咖啡因敏感、儿童或孕期人群应进一步确认含量。', evidence: 'label_text' },
  { key: 'alcohol', pattern: /酒精|乙醇|朗姆|白兰地|啤酒|葡萄酒/i, title: '酒精相关提示', detail: '出现酒精或酒类来源词；不能仅凭配料表推断最终酒精度，应查看酒精度或产品类别。', evidence: 'label_text' }
];

function clean(value) { return String(value || '').replace(/[|｜]/g, ' ').replace(/\s+/g, ' ').trim(); }

export const LABEL_SOURCES = [
  { title: '中国居民膳食指南（2022）· 平衡膳食八准则', url: 'https://dg.cnsoc.org/article/04/J4-AsD_DR3OLQMnHG0-jZA.html', detail: '一般健康成年人：盐不超过5g/日；添加糖不超过50g、最好25g以下。不是单个食品的额度。' },
  { title: '国家卫健委 · GB 28050-2025 问答', url: STANDARD_SOURCES['GB 28050'].url, detail: 'NRV%是标签比较参考，不是个人需求或安全上限；2025版2027-03-16实施。糖没有规定NRV。' },
  { title: 'WHO · Healthy diet（2026）', url: 'https://www.who.int/news-room/fact-sheets/detail/healthy-diet', detail: '成年人盐少于5g（钠2g）/日；限制游离糖，注意饱和与反式脂肪。游离糖与添加糖定义不同。' },
  { title: 'WHO · Food additives（2023）', url: 'https://www.who.int/news-room/fact-sheets/detail/food-additives', detail: '添加剂需按用途与暴露量评估；防腐剂可延缓腐败。名称本身不能证明有害或合规。' },
  { title: '国家卫健委 · GB 2760-2024 发布公告', url: STANDARD_SOURCES['GB 2760'].url, detail: '中国食品添加剂使用规则入口；本程序未逐项核验产品类别和限量，不作合规结论。' },
  { title: 'FDA · Aspartame and Other Sweeteners', url: 'https://www.fda.gov/food/food-additives-petitions/aspartame-and-other-sweeteners-food', detail: '提供甜味剂科普与苯丙酮尿症提示；不用于判断在中国的使用合规性。' }
].map(source => ({ ...source, checkedAt: '2026-11-26' }));

const ADDITIVE_RULES = [
  { names: ['山梨酸钾','山梨酸','苯甲酸钠','苯甲酸','丙酸钙','丙酸钠','脱氢乙酸钠','脱氢乙酸','乳酸链球菌素','纳他霉素'], category: '防腐剂', purpose: '抑制部分微生物，延缓食品腐败；不是让变质食品重新安全。', caution: '具体允许使用的食品类别和限量不同；仅凭包装名字无法判断是否超量。脱氢乙酸及其钠盐等需特别核对现行食品类别限制。' },
  { names: ['亚硝酸钠','亚硝酸钾','硝酸钠','硝酸钾'], category: '防腐/护色相关', purpose: '部分肉制品中的防腐、护色相关成分。', caution: '需核对食品类别、使用量及残留要求；不能从配料名称推断摄入剂量或致癌风险。不要据此把加工肉作为每日主要蛋白质来源。' },
  { names: ['阿斯巴甜','三氯蔗糖','安赛蜜','乙酰磺胺酸钾','甜蜜素','糖精钠','甜菊糖苷','纽甜'], category: '甜味剂', purpose: '提供甜味，不等于糖；无糖也不等于没有能量或可以不限量吃。', caution: '不应将代糖当作长期体重管理的保证。含阿斯巴甜的食品，苯丙酮尿症患者应避免或限制并遵医嘱。' },
  { names: ['赤藓糖醇','木糖醇','山梨糖醇','麦芽糖醇'], category: '糖醇类甜味成分', purpose: '替代部分糖提供甜味；与蔗糖的营养特点不同。', caution: '耐受情况因人而异；不能仅凭名称给出每天可吃几包。无糖不是无限量。' },
  { names: ['柠檬酸','柠檬酸钠','苹果酸','乳酸'], category: '酸度调节相关', purpose: '调节酸味和酸碱度，具体功能以产品标示为准。', caution: '不能因为化学名称就判为有害，也不能由名称推断用量。' },
  { names: ['抗坏血酸','异抗坏血酸钠','特丁基对苯二酚','TBHQ','丁基羟基茴香醚','BHA','二丁基羟基甲苯','BHT'], category: '抗氧化相关', purpose: '减缓氧化、帮助维持品质；不同于抑制微生物的防腐。', caution: '抗氧化剂不是保健承诺；仍需核对食品类别和限量。' },
  { names: ['黄原胶','卡拉胶','瓜尔胶','羧甲基纤维素钠','果胶','单，双甘油脂肪酸酯','单、双甘油脂肪酸酯','大豆磷脂'], category: '增稠/稳定/乳化相关', purpose: '改善稠度、质地或油水混合状态；这些成分不都是防腐剂。', caution: '实际功能依产品而定；有已知过敏或不耐受情况应核对完整包装。' },
  { names: ['柠檬黄','日落黄','胭脂红','诱惑红','亮蓝','焦糖色','β-胡萝卜素'], category: '着色相关', purpose: '调整或保持食品颜色。', caution: '颜色来源不能直接说明营养价值或安全性；应核对具体食品类别允许的使用条件。' },
  { names: ['食用香精','食用香料','谷氨酸钠','5′-呈味核苷酸二钠'], category: '增香/增味相关', purpose: '改善香气或鲜味，不能代替实际食材的营养。', caution: '不等于有害；含钠的增味成分应与营养表中的总钠一起看。' }
];

function labelBasis(text) {
  const section = text.slice(Math.max(0, text.search(/营养成分表|营养成分/)));
  const headers = [...section.matchAll(/每\s*(100\s*(?:克|毫升|g|ml)|份(?:\s*[（(]?\s*(\d+(?:\.\d+)?)\s*(克|毫升|g|ml)\s*[）)]?)?)/gi)];
  const kinds = new Set(headers.map(m => /^份/.test(m[1]) ? 'serving' : /毫升|ml/i.test(m[1]) ? 'ml' : 'g'));
  const net = text.match(/净含量\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(千克|公斤|kg|克|g|毫升|ml|升|l)(?![a-z])/i);
  const normalizeUnit = u => /毫升|ml|^升$|^l$/i.test(u) ? 'ml' : 'g';
  const netQuantity = net ? { value: Number(net[1]) * (/千克|公斤|kg|^升$|^l$/i.test(net[2]) ? 1000 : 1), unit: normalizeUnit(net[2]) } : null;
  // Multiple nutrition columns are ambiguous: never silently pair values from different columns.
  if (kinds.size !== 1) return { kind: 'unknown', label: kinds.size ? '多列营养表，需校对成单列' : '未识别计量基准', quantity: null, unit: null, netQuantity };
  const m = headers[0];
  if (kinds.has('serving')) return { kind: 'serving', label: '每份', quantity: m[2] ? Number(m[2]) : null, unit: m[3] ? normalizeUnit(m[3]) : null, netQuantity };
  const unit = kinds.has('ml') ? 'ml' : 'g';
  return { kind: 'hundred', label: `每100${unit}`, quantity: 100, unit, netQuantity };
}

function parseNutrition(text, basis) {
  const nutrition = {};
  const rules = { energy: ['能量','kJ|千焦'], protein: ['蛋白质','g|克'], saturatedFat: ['(?<!不)饱和脂肪(?:酸)?','g|克'], transFat: ['反式脂肪(?:酸)?','g|克'], fat: ['(?<!饱和)(?<!反式)(?<!不饱和)脂肪(?:酸)?','g|克'], carbohydrate: ['碳水化合物','g|克'], addedSugar: ['添加糖','g|克'], sugar: ['(?<!添加)糖(?:[（(]乳糖[）)])?','g|克'], sodium: ['钠','mg|毫克'], fiber: ['膳食纤维','g|克'], calcium: ['钙','mg|毫克'], iron: ['铁','mg|毫克'] };
  // Restrict to the nutrition block to avoid using ingredient percentages as NRV.
  const start = text.search(/营养成分表|营养成分/);
  const block = start >= 0 ? text.slice(start) : text;
  for (const [key, [name, unit]] of Object.entries(rules)) {
    const normalized = block.replace(new RegExp(`(${name})\\s*[（(](${unit})[）)]\\s*([0-9]+(?:\\.[0-9]+)?)`, 'gi'), '$1 $3 $2');
    const match = normalized.match(new RegExp(`${name}\\s*([0-9]+(?:\\.[0-9]+)?)\\s*(${unit})(?:\\s*(\\d+(?:\\.\\d+)?)\\s*[%％])?`, 'i'));
    if (!match) continue;
    nutrition[key] = { value: Number(match[1]), unit: key === 'energy' ? 'kJ' : ['sodium','calcium','iron'].includes(key) ? 'mg' : 'g', basis: basis.kind === 'unknown' ? 'unknown' : basis.kind === 'serving' ? 'per_serving_or_label' : 'per_100g_or_100ml', nrvPercent: ['sugar','addedSugar','transFat'].includes(key) || match[3] === undefined ? null : Number(match[3]), nrvSource: ['sugar','addedSugar','transFat'].includes(key) || match[3] === undefined ? null : 'label' };
  }
  return nutrition;
}

export function portionAnalysis(report, quantity, unit) {
  const basis = report.basis;
  const count = Number(quantity);
  const factor = basis?.kind !== 'unknown' && Number.isFinite(count) && count > 0 ? unit === 'serving' && basis?.kind === 'serving' ? count : basis?.quantity > 0 && unit === basis.unit ? count / basis.quantity : null : null;
  if (!(factor > 0)) return { valid: false, message: '请先补全单列营养表的每100g、每100ml或每份基准；克和毫升不能直接互换。' };
  const nutrients = Object.fromEntries(Object.entries(report.nutrition).map(([key, item]) => [key, { ...item, value: +(item.value * factor).toFixed(2), nrvPercent: item.nrvPercent == null ? null : +(item.nrvPercent * factor).toFixed(1) }]));
  const metrics = [];
  for (const [key, name] of [['fat','脂肪'],['saturatedFat','饱和脂肪'],['sodium','钠']]) {
    const item = nutrients[key];
    if (item?.nrvPercent != null) metrics.push({ name, percent: item.nrvPercent, source: '标签NRV', color: item.nrvPercent > 20 ? 'red' : item.nrvPercent > 5 ? 'yellow' : 'green' });
  }
  if (nutrients.sodium && nutrients.sodium.nrvPercent == null) { const percent = nutrients.sodium.value / 20; metrics.push({name:'钠', percent:+percent.toFixed(1), source:'2000mg全天控制量（非识别到的NRV）', color:percent > 20 ? 'red' : percent > 5 ? 'yellow' : 'green'}); }
  if (nutrients.addedSugar) { const percent = nutrients.addedSugar.value / 25 * 100; metrics.push({ name: '添加糖', percent: +percent.toFixed(1), source: '25g较优控制目标（非NRV）', color: percent > 20 ? 'red' : percent > 5 ? 'yellow' : 'green' }); }
  const color = metrics.some(m => m.color === 'red') ? 'red' : metrics.some(m => m.color === 'yellow') ? 'yellow' : metrics.length ? 'green' : 'gray';
  const budgets = [];
  if (nutrients.sodium) budgets.push(`这次摄入钠 ${nutrients.sodium.value}mg，约合盐 ${(nutrients.sodium.value * 2.5 / 1000).toFixed(2)}g，占成人全天2000mg钠控制量的 ${(nutrients.sodium.value / 20).toFixed(1)}%。`);
  if (nutrients.sugar) budgets.push(`这次总糖 ${nutrients.sugar.value}g；总糖可能含天然乳糖等，不能全部当成添加糖或游离糖。`);
  if (nutrients.addedSugar) budgets.push(`这次添加糖 ${nutrients.addedSugar.value}g，占全天25g较优控制目标的 ${(nutrients.addedSugar.value / 25 * 100).toFixed(1)}%。`);
  const ceilings = [];
  // Leave most of the daily budget for other meals. This is a transparent app heuristic, not a safety limit.
  const amountPerUnit = factor / count;
  if (nutrients.sodium?.value > 0) ceilings.push({ nutrient: '钠', quantity: Math.floor(400 / (nutrients.sodium.value / count) * 10) / 10, unit, budget: '400mg钠（全天控制量的20%）' });
  if (nutrients.addedSugar?.value > 0) ceilings.push({ nutrient: '添加糖', quantity: Math.floor(5 / (report.nutrition.addedSugar.value * amountPerUnit) * 10) / 10, unit, budget: '5g添加糖（25g目标的20%）' });
  return { valid: true, quantity: count, unit, nutrients, metrics, color, budgets, ceilings, note: '参考灯为本程序自定：当前食用量中已识别的脂肪/饱和脂肪/钠NRV或添加糖目标占比≤5%绿、>5%至20%黄、>20%红。不是膳食指南官方评级、营养密度评级或安全结论；绿灯不代表可以不限量吃，缺失项目不按零处理。' };
}

export function parseLabelText(rawText = '') {
  const lines = String(rawText).split(/\r?\n/).map(clean).filter(Boolean);
  const text = lines.join(' ');
  const productName = lines.find(line => !/配料|营养|净含量|生产日期|保质期|执行标准|储存|贮存|地址|电话|规格/.test(line) && line.length >= 2 && line.length <= 32) || '';
  const ingredientStart = lines.findIndex(line => /配料表?|配料：|配料\s/.test(line));
  const nutritionStart = lines.findIndex(line => /营养成分表|营养成分|能量/.test(line));
  const metadataStart = lines.findIndex((line, i) => i > ingredientStart && /营养成分|净含量|执行标准|生产日期|保质期|储存|贮存/.test(line));
  const end = metadataStart > ingredientStart ? metadataStart : nutritionStart > ingredientStart && ingredientStart >= 0 ? nutritionStart : lines.length;
  const ingredientText = ingredientStart >= 0 ? lines.slice(ingredientStart, end).join(' ').replace(/^.*?配料表?[:：]?/,'') : '';
  const ingredientTokens = ingredientText.split(/[、,，;；。]/).map(clean).filter(token => token && token.length <= 60).map((name, index) => ({ name, order: index + 1, emphasis: index < 3 }));
  const basis = labelBasis(text);
  const nutrition = parseNutrition(text, basis);
  const standards = [...new Set(text.match(/(?:GB(?:\/T)?|QB\/T|NY\/T)\s*\d+(?:\.\d+)?(?:[-—]\s*\d{4})?/gi) || [])].map(code => code.replace(/\s+/g, ' ').replace(/—/g, '-'));
  const allergens = ALLERGENS.filter(name => new RegExp(name, 'i').test(text));
  const flags = FLAG_RULES.filter(rule => rule.pattern.test(text)).map(rule => ({ key: rule.key, title: rule.title, detail: rule.detail, evidence: rule.evidence }));
  return { productName, rawText: lines.join('\n'), ingredients: ingredientTokens, nutrition, basis, standards, allergens, flags, confidence: ingredientTokens.length || Object.keys(nutrition).length ? 65 : 0 };
}

export function enrichStandards(codes = []) {
  return codes.map(code => {
    const base = Object.keys(STANDARD_SOURCES).find(key => code.toUpperCase().startsWith(key));
    return { code, ...(base ? STANDARD_SOURCES[base] : { title: '需要到国家标准平台核对的标准', status: '未内置解释，仅展示标准号，不作合规结论', url: 'https://std.samr.gov.cn/' }) };
  });
}

export function analyzeLabel(rawText, portion = {}) {
  const report = parseLabelText(rawText);
  report.standards = enrichStandards(report.standards);
  report.analysisVersion = 2;
  const ingredients = report.ingredients.map(i => i.name.replace(/(?:不含|不添加|无添加|未添加)[^、,，;；。]*/g, '')).join('、');
  report.additives = ADDITIVE_RULES.flatMap(rule => rule.names.filter(name => ingredients.includes(name) && !rule.names.some(longer => longer !== name && longer.includes(name) && ingredients.includes(longer))).map(name => ({ name, category: rule.category, purpose: rule.purpose, caution: rule.caution })));
  report.additiveNote = '常见成分词典匹配，不是穷尽鉴定。未匹配不等于不含添加剂；“不添加防腐剂”等宣传不作检出依据。未获得添加量、食品类别和全部来源摄入量，不能判断超量，也不能换算ADI或每天可吃几包。';
  report.mainIngredients = report.ingredients.slice(0, 3).map(i => i.name);
  report.sources = LABEL_SOURCES;
  report.dailyGuidance = '一般健康成年人：全天盐不超过5g（约2000mg钠）；添加糖不超过50g、最好控制在25g以下。NRV是标签统一参考，不是个人推荐摄入量或安全上限；蛋白质、膳食纤维并非越低越好。儿童、孕期及慢性病人群需个体化建议。';
  report.portion = portionAnalysis(report, portion.quantity ?? (report.basis.kind === 'serving' ? 1 : report.basis.quantity), portion.unit ?? (report.basis.kind === 'serving' ? 'serving' : report.basis.unit));
  report.summary = report.confidence ? '已提取配料和部分营养信息，请核对低置信度内容后再参考。' : '暂未提取到足够文字，请重新拍摄并保证配料表平整、清晰、无遮挡。';
  report.disclaimer = '本报告用于帮助理解包装信息，不是医疗诊断、食品检测或法律合规结论。';
  return report;
}

export { STANDARD_SOURCES, ALLERGENS };
