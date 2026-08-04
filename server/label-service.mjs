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
function number(value) { const n = Number(String(value || '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; }

export function parseLabelText(rawText = '') {
  const lines = String(rawText).split(/\r?\n/).map(clean).filter(Boolean);
  const text = lines.join(' ');
  const productName = lines.find(line => !/配料|营养|净含量|生产日期|保质期|执行标准|储存|贮存|地址|电话|规格/.test(line) && line.length >= 2 && line.length <= 32) || '';
  const ingredientStart = lines.findIndex(line => /配料表?|配料：|配料\s/.test(line));
  const nutritionStart = lines.findIndex(line => /营养成分表|营养成分|能量/.test(line));
  const end = nutritionStart > ingredientStart && ingredientStart >= 0 ? nutritionStart : lines.length;
  const ingredientText = ingredientStart >= 0 ? lines.slice(ingredientStart, end).join(' ').replace(/^.*?配料表?[:：]?/,'') : '';
  const ingredientTokens = ingredientText.split(/[、,，;；。]/).map(clean).filter(token => token && token.length <= 60).map((name, index) => ({ name, order: index + 1, emphasis: index < 3 }));
  const nutrition = {};
  const nutritionRules = [
    ['energy', /能量\s*([\d.]+)\s*(千焦|kJ|kj)/i], ['protein', /蛋白质\s*([\d.]+)\s*g/i], ['fat', /脂肪\s*([\d.]+)\s*g/i],
    ['saturatedFat', /饱和脂肪(?:酸)?\s*([\d.]+)\s*g/i], ['carbohydrate', /碳水化合物\s*([\d.]+)\s*g/i], ['sugar', /糖\s*([\d.]+)\s*g/i],
    ['sodium', /钠\s*([\d.]+)\s*mg/i], ['fiber', /膳食纤维\s*([\d.]+)\s*g/i]
  ];
  for (const [key, rule] of nutritionRules) { const match = text.match(rule); if (match) nutrition[key] = { value: number(match[1]), unit: match[2] || (key === 'energy' ? 'kJ' : key === 'sodium' ? 'mg' : 'g'), basis: /每份|每份量/.test(text) ? 'per_serving_or_label' : 'per_100g_or_100ml' }; }
  const standards = [...new Set(text.match(/(?:GB(?:\/T)?|QB\/T|NY\/T)\s*\d+(?:\.\d+)?(?:[-—]\s*\d{4})?/gi) || [])].map(code => code.replace(/\s+/g, ' ').replace(/—/g, '-'));
  const allergens = ALLERGENS.filter(name => new RegExp(name, 'i').test(text));
  const flags = FLAG_RULES.filter(rule => rule.pattern.test(text)).map(rule => ({ key: rule.key, title: rule.title, detail: rule.detail, evidence: rule.evidence }));
  return { productName, rawText: lines.join('\n'), ingredients: ingredientTokens, nutrition, standards, allergens, flags, confidence: ingredientTokens.length || Object.keys(nutrition).length ? 65 : 0 };
}

export function enrichStandards(codes = []) {
  return codes.map(code => {
    const base = Object.keys(STANDARD_SOURCES).find(key => code.toUpperCase().startsWith(key));
    return { code, ...(base ? STANDARD_SOURCES[base] : { title: '需要到国家标准平台核对的标准', status: '未内置解释，仅展示标准号，不作合规结论', url: 'https://std.samr.gov.cn/' }) };
  });
}

export function analyzeLabel(rawText) {
  const report = parseLabelText(rawText);
  report.standards = enrichStandards(report.standards);
  report.summary = report.confidence ? '已提取配料和部分营养信息，请核对低置信度内容后再参考。' : '暂未提取到足够文字，请重新拍摄并保证配料表平整、清晰、无遮挡。';
  report.disclaimer = '本报告用于帮助理解包装信息，不是医疗诊断、食品检测或法律合规结论。';
  return report;
}

export { STANDARD_SOURCES, ALLERGENS };
