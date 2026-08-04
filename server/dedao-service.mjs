const DEFAULT_BASE_URL = 'https://openapi.biji.com';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function firstText(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
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
    for (const key of ['image_url', 'imageUrl', 'original_url', 'originalUrl', 'access_url', 'accessUrl', 'url']) {
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

function normalizeNote(detail, sourceUrl) {
  const note = detail?.data?.note || detail?.data || detail?.note || {};
  const webPage = note.web_page || note.webPage || {};
  const attachments = note.attachments || note.attachment || [];
  const rawText = firstText(webPage.content, note.content, note.raw_text, note.rawText, webPage.excerpt, note.excerpt);
  const summary = firstText(webPage.excerpt, note.excerpt, note.summary, note.ai_summary, rawText);
  const title = firstText(note.title, webPage.title, note.name, '抖音菜谱');
  const imageUrls = collectImageUrls({ attachments, webPage, note, imageUrls: note.image_urls || note.imageUrls });
  const source = firstText(webPage.url, note.source_url, note.sourceUrl, sourceUrl);
  return {
    ok: true,
    provider: true,
    providerName: 'dedao-brain',
    status: 'needs_review',
    title,
    summary,
    rawText,
    coverUrl: imageUrls[0] || '',
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
    return { ...normalizeNote(detail, url), dedaoNoteId: String(noteId) };
  }

  return { configured, resolveLink };
}
