'use strict';

// Checks resources in the integrated demo, not physical network disconnection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

test('integrated demo pages serve their declared assets locally', async (t) => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'opencredit-local-assets-'));
  const server = spawn(process.execPath, ['phase1/start-demo.js'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, PHASE1_PORT: String(port), PHASE1_DB_PATH: path.join(directory, 'demo.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => server.kill('SIGTERM'));
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Demo server exited: ${server.exitCode}`);
    try { await fetch(`${origin}/phase1/home`); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  assert.ok(ready, 'demo server did not start');

  const seen = new Set();
  async function checkAsset(reference, base) {
    if (reference.startsWith('data:') || reference.startsWith('#')) return;
    const url = new URL(reference, base);
    assert.equal(url.origin, origin, `external asset: ${url.href}`);
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const response = await fetch(url);
    assert.equal(response.status, 200, `missing asset: ${url.pathname}`);
    if (url.pathname.endsWith('.css')) {
      const css = await response.text();
      for (const match of css.matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi)) {
        await checkAsset(match[1].trim(), url);
      }
    }
  }
  for (const page of ['/phase1/home', '/phase1/']) {
    const response = await fetch(`${origin}${page}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>mck_mifare(?: — Makine testi)?<\/title>/);
    for (const tag of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
      const attribute = tag[0].match(/\b(?:src|href)\s*=\s*['"]([^'"]+)['"]/i);
      if (attribute) await checkAsset(attribute[1], `${origin}${page}`);
    }
  }
  assert.ok(seen.size > 5, 'expected local scripts and styles');
});
