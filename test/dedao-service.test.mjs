import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDedaoClient } from '../server/dedao-service.mjs';

test('dedao adapter saves a link, polls it, and returns summary plus cover', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/open/api/v1/resource/note/save')) return new Response(JSON.stringify({ success: true, data: { tasks: [{ task_id: 'task-1' }] } }), { status: 200 });
    if (url.endsWith('/open/api/v1/resource/note/task/progress')) return new Response(JSON.stringify({ success: true, data: { status: 'success', note_id: 'note-1' } }), { status: 200 });
    if (url.includes('/open/api/v1/resource/note/detail')) return new Response(JSON.stringify({ success: true, data: { note: { title: '番茄炒蛋', web_page: { excerpt: '得到大脑总结：番茄炒蛋，酸甜下饭。' }, attachments: [{ type: 'image', image_url: 'https://cdn.example.com/cover.jpg' }] } } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const client = createDedaoClient({ apiKey: 'gk_live_test', clientId: 'cli_test', pollIntervalMs: 1 });
    const result = await client.resolveLink('https://v.douyin.com/example/');
    assert.equal(result.providerName, 'dedao-brain');
    assert.equal(result.title, '番茄炒蛋');
    assert.equal(result.coverUrl, 'https://cdn.example.com/cover.jpg');
    assert.ok(Array.isArray(result.ingredients));
    assert.ok(Array.isArray(result.steps));
    assert.equal(typeof result.characteristics, 'string');
    assert.equal(calls[0].options.headers.Authorization, 'gk_live_test');
    assert.equal(calls[0].options.headers['X-Client-ID'], 'cli_test');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
