import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('food flow page contains one compilable inline script and shopping screen', () => {
  const html = fs.readFileSync(new URL('../designs/food-flow/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0][1], { filename: 'designs/food-flow/index.html' });
  assert.match(html, /id="screen-shopping"/);
  assert.match(html, /id="receipt-scan-button"/);
  assert.match(html, /id="receipt-gallery"/);
  assert.match(html, /id="label-gallery"/);
});
