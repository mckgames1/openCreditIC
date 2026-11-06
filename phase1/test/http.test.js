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
    assert.equal(result.response.status, 409);
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

test('new demo account and card flow remains idempotent through topup and play', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencreditic-new-card-'));
  const running = startServer({ host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'demo.sqlite') });
  await new Promise(resolve => running.server.once('listening', resolve));
  const base = `http://127.0.0.1:${running.server.address().port}`;
  try {
    const setup = await jsonRequest(base, '/phase1/api/setup', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }) });
    const cookie = setup.cookie;
    const register = { name: 'Deneme', uid: '00112233', idempotencyKey: 'registration-test-001' };
    const first = await jsonRequest(base, '/phase1/api/demo/register', { method: 'POST', body: JSON.stringify(register) }, cookie);
    assert.equal(first.response.status, 201);
    const repeat = await jsonRequest(base, '/phase1/api/demo/register', { method: 'POST', body: JSON.stringify(register) }, cookie);
    assert.equal(repeat.data.account.id, first.data.account.id);
    assert.equal(repeat.data.duplicate, true);
    const topup = { accountId: first.data.account.id, cardUid: register.uid, amountTl: '25.00', idempotencyKey: 'new-card-topup-001' };
    await jsonRequest(base, '/phase1/api/topups', { method: 'POST', body: JSON.stringify(topup) }, cookie);
    const dupTopup = await jsonRequest(base, '/phase1/api/topups', { method: 'POST', body: JSON.stringify(topup) }, cookie);
    assert.equal(dupTopup.data.duplicate, true);
    await jsonRequest(base, '/phase1/api/demo/simulator/card', { method: 'POST', body: JSON.stringify({ action: 'approach', cardUid: register.uid }) }, cookie);
    const payment = { cardUid: register.uid, machineId: 'DEMO-MACHINE', idempotencyKey: 'new-card-payment-001' };
    const paid = await jsonRequest(base, '/phase1/api/demo/payment', { method: 'POST', body: JSON.stringify(payment) }, cookie);
    assert.equal(paid.data.balanceAfterCents, 0);
    const duplicate = await jsonRequest(base, '/phase1/api/demo/payment', { method: 'POST', body: JSON.stringify(payment) }, cookie);
    assert.equal(duplicate.data.duplicate, true);
    const held = await jsonRequest(base, '/phase1/api/demo/payment', { method: 'POST', body: JSON.stringify({ ...payment, idempotencyKey: 'new-card-payment-002' }) }, cookie);
    assert.equal(held.response.status, 409);
    assert.equal(running.store.summary().pulseCount, 1);
    assert.equal(running.store.getAccount(first.data.account.id).tl_balance_cents, 0);
  } finally { await running.close(); }
});

test('only admin can record an idempotent review; restart preserves original payment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-review-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  let adminCookie;
  let commandId;
  const post = (route, body, cookie) => jsonRequest(base, route, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    adminCookie = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, adminCookie);
    const staffCookie = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    await post('/phase1/api/topups', { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '200', idempotencyKey: 'review-topup-001' }, adminCookie);
    await post('/phase1/api/demo/simulator/card', { action: 'approach', cardUid: 'DEMO-0001' }, adminCookie);
    commandId = (await post('/phase1/api/demo/payment', { cardUid: 'DEMO-0001', idempotencyKey: 'review-payment-001' }, adminCookie)).data.pulseCommandId;
    await post(`/phase1/api/demo/pulse/${commandId}/simulate`, { outcome: 'response_lost' }, adminCookie);
    const body = { decision: 'needs_follow_up', reason: 'Yanıt alınamadı, kontrol gerekli.', idempotencyKey: 'review-request-001' };
    assert.equal((await post(`/phase1/api/demo/pulse/${commandId}/review`, body, staffCookie)).response.status, 403);
    assert.equal((await post(`/phase1/api/demo/pulse/${commandId}/review`, { ...body, reason: 'kısa' }, adminCookie)).response.status, 400);
    const recorded = await post(`/phase1/api/demo/pulse/${commandId}/review`, body, adminCookie);
    assert.equal(recorded.response.status, 201);
    // Treat the first response as lost and retry exactly the same request.
    const repeated = await post(`/phase1/api/demo/pulse/${commandId}/review`, body, adminCookie);
    assert.equal(repeated.data.review.id, recorded.data.review.id);
    assert.equal(repeated.data.duplicate, true);
    assert.equal((await post(`/phase1/api/demo/pulse/${commandId}/review`, { ...body, reason: 'Farklı bir açıklama yazıldı.' }, adminCookie)).response.status, 409);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    const after = await jsonRequest(base, '/phase1/api/state', {}, adminCookie);
    assert.equal(after.data.reviews.length, 1);
    assert.equal(after.data.reviews[0].reason, body.reason);
    assert.equal(after.data.pulses.find(p => p.id === commandId).status, 'ambiguous');
    assert.equal(after.data.accounts.find(a => a.id === 'demo-account').tl_balance_cents, 17500);
    assert.equal(after.data.summary.pulseCount, 1);
    assert.equal(after.data.ledger.length, 2);
  } finally { await running.close(); }
});
