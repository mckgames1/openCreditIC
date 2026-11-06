'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startServer } = require('../server');

async function jsonRequest(base, pathName, options = {}, cookie = '') {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}${pathName}`, { ...options, headers });
  const data = await response.json();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
}

test('local demo flow enforces card removal and repeats one payment safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencreditic-http-'));
  const running = startServer({ host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'demo.sqlite') });
  await new Promise((resolve) => running.server.once('listening', resolve));
  const base = `http://127.0.0.1:${running.server.address().port}`;
  let cookie = '';
  try {
    let result = await jsonRequest(base, '/phase1/api/setup', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }) });
    assert.equal(result.response.status, 201);
    cookie = result.cookie;
    result = await jsonRequest(base, '/phase1/api/topups', { method: 'POST', body: JSON.stringify({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '200,00', idempotencyKey: 'http-topup-001' }) }, cookie);
    assert.equal(result.response.status, 201);
    result = await jsonRequest(base, '/phase1/api/demo/simulator/card', { method: 'POST', body: JSON.stringify({ action: 'approach', cardUid: 'DEMO-0001' }) }, cookie);
    assert.equal(result.response.status, 200);
    await jsonRequest(base, '/phase1/api/demo/simulator/card', { method: 'POST', body: JSON.stringify({ action: 'hold', cardUid: 'DEMO-0001' }) }, cookie);
    result = await jsonRequest(base, '/phase1/api/demo/payment', { method: 'POST', body: JSON.stringify({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'http-payment-001' }) }, cookie);
    assert.equal(result.response.status, 201);
    const pulseId = result.data.pulseCommandId;
    await jsonRequest(base, '/phase1/api/demo/simulator/card', { method: 'POST', body: JSON.stringify({ action: 'approach', cardUid: 'DEMO-0001' }) }, cookie);
    result = await jsonRequest(base, '/phase1/api/demo/payment', { method: 'POST', body: JSON.stringify({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'http-held-payment-001' }) }, cookie);
    assert.equal(result.response.status, 409);
    result = await jsonRequest(base, '/phase1/api/demo/payment', { method: 'POST', body: JSON.stringify({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'http-payment-001' }) }, cookie);
    assert.equal(result.response.status, 200);
    assert.equal(result.data.duplicate, true);
    result = await jsonRequest(base, '/phase1/api/demo/payment', { method: 'POST', body: JSON.stringify({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'http-payment-002' }) }, cookie);
    assert.equal(result.response.status, 409);
    await jsonRequest(base, `/phase1/api/demo/pulse/${pulseId}/simulate`, { method: 'POST', body: JSON.stringify({ outcome: 'response_lost' }) }, cookie);
    result = await jsonRequest(base, `/phase1/api/demo/pulse/${pulseId}/retry`, { method: 'POST', body: '{}' }, cookie);
    assert.equal(result.data.pulse.id, pulseId);
    result = await jsonRequest(base, '/phase1/api/admin/users', { method: 'POST', body: JSON.stringify({ username: 'staff', password: 'staff password 1', role: 'staff' }) }, cookie);
    assert.equal(result.response.status, 201);
    result = await jsonRequest(base, '/phase1/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'staff', password: 'staff password 1' }) });
    assert.equal(result.response.status, 200);
    const staffCookie = result.cookie;
    result = await jsonRequest(base, '/phase1/api/machines/DEMO-MACHINE', { method: 'PATCH', body: JSON.stringify({ priceTl: '30,00' }) }, staffCookie);
    assert.equal(result.response.status, 403);
  } finally {
    await running.close();
  }
});

test('insufficient balance is reported as a rejected payment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencreditic-negative-'));
  const running = startServer({ host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'demo.sqlite') });
  await new Promise((resolve) => running.server.once('listening', resolve));
  const base = `http://127.0.0.1:${running.server.address().port}`;
  try {
    const setup = await jsonRequest(base, '/phase1/api/setup', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }) });
    await jsonRequest(base, '/phase1/api/demo/simulator/card', { method: 'POST', body: JSON.stringify({ action: 'approach', cardUid: 'DEMO-0001' }) }, setup.cookie);
    const result = await jsonRequest(base, '/phase1/api/demo/payment', { method: 'POST', body: JSON.stringify({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'insufficient-payment-001' }) }, setup.cookie);
    assert.equal(result.response.status, 402);
    assert.equal(result.data.approved, false);
    assert.equal(running.store.summary().pulseCount, 0);
  } finally { await running.close(); }
});
