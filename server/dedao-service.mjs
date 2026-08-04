const DEFAULT_BASE_URL = 'https://openapi.biji.com';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function firstText(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

const ingredientLexicon = [
  '西红柿', '番茄', '白玉菇', '香菇', '金针菇', '豆腐', '鱼片', '虾仁', '鸡胸肉', '鸡腿', '鸡蛋', '牛肉', '猪肉',
  '玉米', '土豆', '胡萝卜', '洋葱', '青椒', '红椒', '蒜末', '大蒜', '蒜', '葱花', '葱', '姜', '香菜',
  '生抽', '老抽', '蚝油', '料酒', '淀粉', '胡椒粉', '辣椒', '食盐', '盐', '白糖', '醋', '清水', '食用油', '橄榄油', '油'
];

function amountNear(text, index, name) {
  const windowText = text.slice(Math.max(0, index - 8), index + name.length + 18);
  return windowText.match(/(?:\d+(?:\.\d+)?\s*(?:克|千克|g|kg|毫升|ml|个|根|片|勺|汤匙|把)|两勺|一勺|一点点|适量)/i)?.[0] || '适量';
}

function deriveIngredients(text) {
  const found = [];
  const add = (name, amount = '适量') => {
    const clean = String(name || '').replace(/^[\s，,、;；:：]+|[\s，,、;；:：]+$/g, '').trim();
    if (!clean || clean.length > 12 || /步骤|做法|特点|这种吃法/.test(clean) || found.some(item => item.name === clean)) return;
    found.push({ name: clean, amount: amount || '适量' });
  };
  const explicit = text.match(/(?:原材料|原料|食材|材料)\s*[:：]\s*([^。！？\n]+)/);
  if (explicit) explicit[1].split(/[，,、；;]/).forEach(part => {
    const clean = part.trim(); const match = clean.match(/^(.+?)\s*(\d+(?:\.\d+)?\s*(?:克|g|毫升|ml|个|根|片|勺|汤匙|把)|适量|一点点)?$/i);
    if (match) add(match[1], match[2] || '适量');
  });
  ingredientLexicon.forEach(name => {
    let cursor = 0;
    while ((cursor = text.indexOf(name, cursor)) >= 0) { add(name, amountNear(text, cursor, name)); cursor += name.length; }
  });
  return found.slice(0, 18);
}

function deriveSteps(text) {
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^.{2,40}[！!]\s*/, '');
  if (!clean) return [];
  let chunks = clean.split(/，(?=(?:盖|撒|出锅|装盘|加入|倒入|放入|煮|炒|蒸|焖|拌匀|翻面|不用|最后))/).map(item => item.trim()).filter(Boolean);
  if (chunks.length === 1) chunks = clean.split(/[。！？；]+/).map(item => item.trim()).filter(Boolean);
  if (chunks.length === 1) chunks = [clean];
  const result = [];
  const titleFor = (chunk, index) => {
    if (/腌/.test(chunk)) return '腌制调味';
    if (/冷锅|下锅|锅中|加入|倒入|放入/.test(chunk)) return '食材入锅';
    if (/盖|焖|煮|蒸|炒/.test(chunk)) return '焖煮入味';
    if (/撒|出锅|装盘/.test(chunk)) return '出锅点缀';
    return `步骤 ${index + 1}`;
  };
  chunks.forEach((chunk, index) => {
    if (chunk.length < 2) return;
    const minutes = chunk.match(/(\d+)\s*分钟/);
    result.push({ title: titleFor(chunk, index), desc: chunk, tip: '具体火候和状态请以原视频为准。', time: minutes ? Number(minutes[1]) * 60 : 120 });
  });
  return result.slice(0, 8);
}

function deriveCharacteristics(text) {
  const sentences = text.split(/[。！？；\n]+/).map(item => item.trim()).filter(Boolean);
  const useful = sentences.filter(item => /入味|鲜嫩|酸甜|香|健康|少油|低脂|快手|不用|不需要|分钟|爆炒|油烟/.test(item));
  const value = useful.slice(-2).join('；') || sentences.slice(0, 2).join('；');
  return value.slice(0, 180);
}

function deriveTitle(text) {
  const first = text.split(/[。！？\n]/)[0]?.trim() || '';
  return first.replace(/[，,].*$/, '').slice(0, 28) || '抖音收藏菜谱';
}

function decodeHtml(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function fetchCoverUrl(sourceUrl, timeoutMs = 8000) {
  try {
    const response = await fetch(sourceUrl, { headers: { 'user-agent': 'Mozilla/5.0 FoodFlow recipe importer' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return '';
    const html = (await response.text()).slice(0, 2_000_000);
    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern); if (match?.[1] && /^https?:\/\//i.test(decodeHtml(match[1]))) return decodeHtml(match[1]);
    }
  } catch {}
  return '';
}

function collectImageUrls(value, result = [], depth = 0) {
  if (!value || depth > 4 || result.length >= 8) return result;
  if (Array.isArray(value)) {
    value.forEach(item => collectImageUrls(item, result, depth + 1));
    return result;
  }
  if (typeof value !== 'object') return result;
  const objectType = String(value.type || value.mime_type || value.mimeType || '').toLowerCase();
  if (objectType.includes('image')) {
    for (const key of ['image_url', 'imageUrl', 'original_url', 'originalUrl', 'access_url', 'accessUrl', 'file_url', 'fileUrl', 'download_url', 'downloadUrl', 'url']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate) && !result.includes(candidate)) result.push(candidate);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (typeof child === 'string' && /^https?:\/\//i.test(child)) {
      const looksLikeImage = /image|cover|thumb|poster|pic|photo|avatar/.test(normalizedKey) || /\.(?:jpe?g|png|webp|gif|heic)(?:\?|$)/i.test(child);
      if (looksLikeImage && !result.includes(child)) result.push(child);
    } else if (child && typeof child === 'object') {
      collectImageUrls(child, result, depth + 1);
    }
  }
  return result;
}

async function normalizeNote(detail, sourceUrl) {
  const note = detail?.data?.note || detail?.data || detail?.note || {};
  const webPage = note.web_page || note.webPage || {};
  const attachments = note.attachments || note.attachment || [];
  const rawText = firstText(webPage.content, note.content, note.raw_text, note.rawText, webPage.excerpt, note.excerpt);
  const summary = firstText(webPage.excerpt, note.excerpt, note.summary, note.ai_summary, rawText);
  const noteTitle = /^FoodFlow\s*/i.test(String(note.title || '')) ? '' : note.title;
  const title = firstText(webPage.title, noteTitle, note.name, deriveTitle(summary));
  const imageUrls = collectImageUrls({ attachments, webPage, note, imageUrls: note.image_urls || note.imageUrls });
  const source = firstText(webPage.url, note.source_url, note.sourceUrl, sourceUrl);
  const coverUrl = imageUrls[0] || await fetchCoverUrl(source);
  return {
    ok: true,
    provider: true,
    providerName: 'dedao-brain',
    status: 'needs_review',
    title,
    summary,
    rawText,
    characteristics: deriveCharacteristics(summary),
    ingredients: deriveIngredients(summary),
    steps: deriveSteps(summary),
    coverUrl,
    sourceUrl: source,
    confidence: summary ? 82 : 42,
    message: summary ? '已取得得到大脑总结，请确认菜名和封面后保存。' : '得到大脑已返回内容，但没有提取到摘要，请手动补充。'
  };
}

export function createDedaoClient({
  baseUrl = DEFAULT_BASE_URL,
  apiKey = '',
  clientId = '',
  pollIntervalMs = 5000,
  timeoutMs = 15000,
  maxWaitMs = 90000
} = {}) {
  const normalizedBase = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const configured = Boolean(apiKey && clientId);

  async function request(path, { method = 'GET', body } = {}) {
    if (!configured) throw Object.assign(new Error('得到大脑 API 未配置'), { code: 'dedao_not_configured' });
    const headers = { Authorization: apiKey, 'X-Client-ID': clientId };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${normalizedBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const message = payload.message || payload.error?.message || `得到大脑接口返回 ${response.status}`;
      throw Object.assign(new Error(message), { statusCode: response.status, payload });
    }
    return payload;
  }

  async function waitForTask(taskId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
      const progress = await request('/open/api/v1/resource/note/task/progress', { method: 'POST', body: { task_id: taskId } });
      const data = progress.data || {};
      const status = String(data.status || '').toLowerCase();
      if (status === 'success') return data.note_id || data.noteId;
      if (status === 'failed') throw Object.assign(new Error(data.message || '得到大脑链接解析失败'), { code: 'dedao_task_failed', payload: progress });
      await sleep(pollIntervalMs);
    }
    throw Object.assign(new Error('得到大脑解析超时，请稍后重试'), { code: 'dedao_timeout' });
  }

  async function resolveLink(sourceUrl) {
    const url = String(sourceUrl || '').trim();
    if (!url) throw Object.assign(new Error('得到大脑解析需要完整链接'), { code: 'dedao_url_required' });
    const saved = await request('/open/api/v1/resource/note/save', {
      method: 'POST',
      body: { note_type: 'link', title: 'FoodFlow 抖音菜谱', link_url: url, tags: ['FoodFlow', '菜谱'] }
    });
    const data = saved.data || {};
    let noteId = data.note_id || data.noteId;
    const taskId = data.tasks?.[0]?.task_id || data.tasks?.[0]?.taskId || data.task_id;
    if (!noteId && taskId) noteId = await waitForTask(taskId);
    if (!noteId) throw Object.assign(new Error('得到大脑未返回笔记 ID'), { code: 'dedao_note_id_missing', payload: saved });
    const detail = await request(`/open/api/v1/resource/note/detail?id=${encodeURIComponent(noteId)}&image_quality=original`);
    return { ...(await normalizeNote(detail, url)), dedaoNoteId: String(noteId) };
  }

  return { configured, resolveLink };
}
