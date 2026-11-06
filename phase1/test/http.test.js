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

// Most scenarios create a demo topup through the required intent first.
// Tests of the direct compatibility route use jsonRequest explicitly.
async function demoTopup(base, body, cookie = '') {
  const options = { method: 'POST', body: JSON.stringify(body) };
  const prepared = await jsonRequest(base, '/phase1/api/demo/topup-intents', options, cookie);
  if (!prepared.response.ok) return prepared;
  return jsonRequest(base, '/phase1/api/topups', options, cookie);
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
    result = await demoTopup(base, { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '200,00', idempotencyKey: 'http-topup-001' }, cookie);
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

test('unknown card and real elapsed hold/removal windows preserve one charge per presentation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-real-wait-'));
  const running = startServer({ host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'demo.sqlite') });
  await new Promise(resolve => running.server.once('listening', resolve));
  const base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    const timing = await jsonRequest(base, '/phase1/api/machines/DEMO-MACHINE/timing', { method: 'PATCH', body: JSON.stringify({ cardRemovedMs: 200, paymentCooldownMs: 200 }) }, admin);
    assert.equal(timing.response.status, 200);
    await demoTopup(base, { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '100', idempotencyKey: 'real-wait-topup-001' }, admin);
    const card = (action, cardUid) => post('/phase1/api/demo/simulator/card', { action, cardUid }, admin);
    const pay = (cardUid, idempotencyKey) => post('/phase1/api/demo/payment', { machineId: 'DEMO-MACHINE', cardUid, idempotencyKey }, admin);
    assert.equal((await card('approach', 'UNKNOWN-0001')).response.status, 200);
    const unknown = await pay('UNKNOWN-0001', 'real-wait-unknown-001');
    assert.equal(unknown.response.status, 404);
    assert.equal(unknown.data.error, 'card_not_found');
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 10000);
    assert.equal(running.store.listLedger().filter(entry => entry.entry_type === 'game_charge').length, 0);
    assert.equal(running.store.summary().pulseCount, 0);
    assert.equal((await card('remove', 'UNKNOWN-0001')).response.status, 200);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await card('approach', 'DEMO-0001')).response.status, 200);
    const first = await pay('DEMO-0001', 'real-wait-payment-001');
    assert.equal(first.response.status, 201);
    assert.equal(first.data.balanceAfterCents, 7500);
    const startedHold = Date.now();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(Date.now() - startedHold >= 200);
    assert.equal((await card('hold', 'DEMO-0001')).response.status, 200);
    const held = await pay('DEMO-0001', 'real-wait-held-001');
    assert.equal(held.response.status, 409);
    assert.equal(held.data.error, 'card_hold_required');
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 7500);
    assert.equal(running.store.summary().pulseCount, 1);
    assert.equal((await card('remove', 'DEMO-0001')).response.status, 200);
    const startedRemoval = Date.now();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(Date.now() - startedRemoval >= 200);
    assert.equal((await card('approach', 'DEMO-0001')).response.status, 200);
    const second = await pay('DEMO-0001', 'real-wait-payment-002');
    assert.equal(second.response.status, 201);
    assert.equal(second.data.balanceAfterCents, 5000);
    assert.notEqual(second.data.pulseCommandId, first.data.pulseCommandId);
    assert.equal(running.store.listLedger().filter(entry => entry.entry_type === 'game_charge').length, 2);
    assert.equal(running.store.summary().pulseCount, 2);
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
    await demoTopup(base, topup, cookie);
    const dupTopup = await demoTopup(base, topup, cookie);
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
    await demoTopup(base, { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '200', idempotencyKey: 'review-topup-001' }, adminCookie);
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

test('machine settings validate pulse range and retain price snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-machine-'));
  const running = startServer({ host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'demo.sqlite') });
  await new Promise(resolve => running.server.once('listening', resolve));
  const base = `http://127.0.0.1:${running.server.address().port}`;
  try {
    const setup = await jsonRequest(base, '/phase1/api/setup', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }) });
    const cookie = setup.cookie;
    const patchMachine = body => jsonRequest(base, '/phase1/api/machines/DEMO-MACHINE', { method: 'PATCH', body: JSON.stringify(body) }, cookie);
    assert.equal((await patchMachine({ pulseMs: 9 })).response.status, 400);
    assert.equal((await patchMachine({ pulseMs: 1001 })).response.status, 400);
    const saved = await patchMachine({ name: 'Deneme', priceTl: '50.00', pulseMs: 150, pulseCount: 2, pulseGapMs: 200 });
    assert.equal(saved.data.machine.price_cents, 5000);
    await demoTopup(base, { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '200', idempotencyKey: 'machine-topup-001' }, cookie);
    await jsonRequest(base, '/phase1/api/demo/simulator/card', { method: 'POST', body: JSON.stringify({ action: 'approach', cardUid: 'DEMO-0001' }) }, cookie);
    const payment = await jsonRequest(base, '/phase1/api/demo/payment', { method: 'POST', body: JSON.stringify({ cardUid: 'DEMO-0001', idempotencyKey: 'machine-payment-001' }) }, cookie);
    await patchMachine({ priceTl: '75.00', pulseMs: 300 });
    const command = running.store.getPulseCommand(payment.data.pulseCommandId);
    assert.equal(command.amount_cents, 5000);
    assert.equal(command.pulse_ms, 150);
    assert.equal(command.pulse_count, 2);
    const state = await jsonRequest(base, '/phase1/api/state', {}, cookie);
    assert.equal(state.data.summary.topups_cents, 20000);
    assert.equal(state.data.summary.game_charges_cents, 5000);
    assert.equal(state.data.accounts.reduce((sum, item) => sum + item.tl_balance_cents, 0), 15000);
  } finally { await running.close(); }
});

test('staff sees only own persisted transactions and cannot change admin settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-staff-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    for (const name of ['staff1', 'staff2']) {
      const created = await post('/phase1/api/admin/users', { username: name, password: 'staff password 1', role: 'staff' }, admin);
      assert.equal(created.response.status, 201);
      assert.equal(created.data.user.role, 'staff');
      assert.equal(Object.hasOwn(created.data.user, 'password_hash'), false);
    }
    assert.equal((await post('/phase1/api/admin/users', { username: 'staff1', password: 'staff password 1', role: 'staff' }, admin)).response.status, 409);
    const staff1 = (await post('/phase1/api/auth/login', { username: 'staff1', password: 'staff password 1' })).cookie;
    const staff2 = (await post('/phase1/api/auth/login', { username: 'staff2', password: 'staff password 1' })).cookie;
    const topup = { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '10', idempotencyKey: 'staff1-topup-001' };
    const first = await demoTopup(base, topup, staff1);
    assert.equal(first.response.status, 201);
    assert.equal((await demoTopup(base, topup, staff1)).data.duplicate, true);
    await demoTopup(base, { ...topup, idempotencyKey: 'staff2-topup-001' }, staff2);
    const denied = await jsonRequest(base, '/phase1/api/machines/DEMO-MACHINE', { method: 'PATCH', body: JSON.stringify({ priceTl: '50' }) }, staff1);
    assert.equal(denied.response.status, 403);
    assert.equal((await post('/phase1/api/admin/users', { username: 'intruder', password: 'staff password 1' }, staff1)).response.status, 403);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    const state = (await jsonRequest(base, '/phase1/api/state', {}, staff1)).data;
    assert.equal(state.ledger.length, 1);
    assert.equal(state.ledger[0].id, first.data.entryId);
    assert.equal(state.summary, null);
    assert.deepEqual(state.pulses, []);
    const history = (await jsonRequest(base, '/phase1/api/history', {}, staff1)).data;
    assert.equal(history.ledger.length, 1);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 2000);
    const { DatabaseSync } = require('node:sqlite');
    const inspection = new DatabaseSync(databasePath);
    assert.equal(inspection.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'balance.credited' AND actor_user_id = ?").get(state.user.id).n, 1);
    inspection.close();
  } finally { await running.close(); }
});

test('demo correction is admin-only, atomic, reasoned, idempotent and separated in reports', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-correction-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    await demoTopup(base, { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '200', idempotencyKey: 'correction-topup-001' }, admin);
    const body = { accountId: 'demo-account', direction: 'subtract', amountTl: '12.34', reason: 'Demo kayıt düzeltmesi', idempotencyKey: 'correction-request-001' };
    assert.equal((await post('/phase1/api/admin/corrections', body, staff)).response.status, 403);
    assert.equal((await post('/phase1/api/admin/corrections', { ...body, reason: 'kısa' }, admin)).response.status, 400);
    assert.equal((await post('/phase1/api/admin/corrections', { ...body, amountTl: '200.01' }, admin)).response.status, 409);
    const created = await post('/phase1/api/admin/corrections', body, admin);
    assert.equal(created.response.status, 201);
    assert.equal(created.data.balanceAfterCents, 18766);
    const repeated = await post('/phase1/api/admin/corrections', body, admin);
    assert.equal(repeated.data.entryId, created.data.entryId);
    assert.equal(repeated.data.duplicate, true);
    assert.equal((await post('/phase1/api/admin/corrections', { ...body, amountTl: '13.00' }, admin)).response.status, 409);
    assert.equal((await post('/phase1/api/admin/corrections', { ...body, amountTl: '0', idempotencyKey: 'correction-zero-001' }, admin)).response.status, 400);
    const positive = await post('/phase1/api/admin/corrections', { ...body, direction: 'add', amountTl: '0.01', idempotencyKey: 'correction-positive-001' }, admin);
    assert.equal(positive.data.balanceAfterCents, 18767);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    const state = (await jsonRequest(base, '/phase1/api/state', {}, admin)).data;
    assert.equal(state.summary.topups_cents, 20000);
    assert.equal(state.summary.game_charges_cents, 0);
    assert.equal(state.summary.corrections_cents, -1233);
    assert.equal(state.ledger.length, 3);
    assert.equal(state.ledger.find(entry => entry.id === created.data.entryId).note, body.reason);
    assert.equal(state.accounts.find(entry => entry.id === 'demo-account').tl_balance_cents, 18767);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'balance.corrected'").get().n, 2);
    db.close();
  } finally { await running.close(); }
});

test('admin can block a demo card without duplicate audit; blocked card cannot be charged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-card-lock-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    await demoTopup(base, { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '25', idempotencyKey: 'card-lock-topup-001' }, admin);
    assert.equal((await post('/phase1/api/cards/DEMO-0001/lock', { locked: true }, staff)).response.status, 403);
    assert.equal((await post('/phase1/api/cards/DEMO-0001/lock', { locked: 'false' }, admin)).response.status, 400);
    assert.equal((await post('/phase1/api/cards/DEMO-0001/lock', { locked: true }, admin)).data.card.locked, true);
    await post('/phase1/api/cards/DEMO-0001/lock', { locked: true }, admin);
    await post('/phase1/api/demo/simulator/card', { action: 'approach', cardUid: 'DEMO-0001' }, admin);
    const payment = await post('/phase1/api/demo/payment', { cardUid: 'DEMO-0001', idempotencyKey: 'card-lock-payment-001' }, admin);
    assert.equal(payment.response.status, 403);
    assert.equal(running.store.summary().pulseCount, 0);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 2500);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'card.locked'").get().n, 1);
    db.close();
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    assert.equal(running.store.getCard('DEMO-0001').locked, 1);
    assert.equal((await post('/phase1/api/cards/DEMO-0001/lock', { locked: false }, admin)).data.card.locked, false);
    assert.equal((await post('/phase1/api/demo/payment', { cardUid: 'DEMO-0001', idempotencyKey: 'card-unlock-payment-001' }, admin)).data.approved, true);
  } finally { await running.close(); }
});

test('second demo card shares account balance and idempotent link survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-link-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    const link = { accountId: 'demo-account', uid: '00112233445566', idempotencyKey: 'attach-card-test-001' };
    assert.equal((await post('/phase1/api/demo/attach-card', link)).response.status, 401);
    const created = await post('/phase1/api/demo/attach-card', link, admin);
    assert.equal(created.response.status, 201);
    assert.equal(created.data.card.uid, link.uid);
    assert.equal((await post('/phase1/api/demo/attach-card', link, admin)).data.duplicate, true);
    assert.equal((await post('/phase1/api/demo/attach-card', { ...link, accountId: 'other-account' }, admin)).response.status, 409);
    assert.equal((await post('/phase1/api/demo/attach-card', { ...link, idempotencyKey: 'attach-card-test-002' }, admin)).response.status, 409);
    await demoTopup(base, { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '200', idempotencyKey: 'attach-topup-001' }, admin);
    await post('/phase1/api/demo/simulator/card', { action: 'approach', cardUid: link.uid }, admin);
    const payment = await post('/phase1/api/demo/payment', { cardUid: link.uid, idempotencyKey: 'attach-payment-001' }, admin);
    assert.equal(payment.data.balanceAfterCents, 17500);
    assert.equal(running.store.getCard('DEMO-0001').tl_balance_cents, 17500);
    assert.equal(running.store.getCard(link.uid).tl_balance_cents, 17500);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    assert.equal((await post('/phase1/api/demo/attach-card', link, admin)).data.duplicate, true);
    assert.equal(running.store.listCards().filter(card => card.account_id === 'demo-account').length, 2);
    assert.equal(running.store.getCard(link.uid).tl_balance_cents, 17500);
  } finally { await running.close(); }
});

test('admin timing settings distinguish short removal and payment cooldown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-timing-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  const patch = (body, cookie, id = 'DEMO-MACHINE') => jsonRequest(base, `/phase1/api/machines/${id}/timing`, { method: 'PATCH', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    assert.equal((await patch({ cardRemovedMs: 0, paymentCooldownMs: 0 }, staff)).response.status, 403);
    assert.equal((await patch({ cardRemovedMs: '', paymentCooldownMs: 0 }, admin)).response.status, 400);
    assert.equal((await patch({ cardRemovedMs: 60001, paymentCooldownMs: 0 }, admin)).response.status, 400);
    const timingA = await patch({ cardRemovedMs: 10000, paymentCooldownMs: 60000 }, admin);
    assert.equal(timingA.response.status, 200);
    assert.equal(timingA.data.machine.settings_version, 2);
    assert.equal((await post('/phase1/api/machines', { id: 'DEVICE-B', name: 'B', priceTl: '25' }, admin)).response.status, 201);
    assert.equal((await patch({ cardRemovedMs: 300, paymentCooldownMs: 0 }, admin, 'DEVICE-B')).response.status, 200);
    await demoTopup(base, { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '100', idempotencyKey: 'timing-topup-001' }, admin);
    const card = action => post('/phase1/api/demo/simulator/card', { action, cardUid: 'DEMO-0001' }, admin);
    const pay = idempotencyKey => post('/phase1/api/demo/payment', { cardUid: 'DEMO-0001', idempotencyKey }, admin);
    await card('approach');
    const firstPayment = await pay('timing-payment-001');
    assert.equal(firstPayment.data.approved, true);
    assert.equal(firstPayment.data.settingsVersion, 2);
    await post('/phase1/api/demo/simulator/card', { action: 'approach', cardUid: 'DEMO-0001', machineId: 'DEVICE-B' }, admin);
    assert.equal((await post('/phase1/api/demo/payment', { cardUid: 'DEMO-0001', machineId: 'DEVICE-B', idempotencyKey: 'timing-device-b-001' }, admin)).data.approved, true);
    await card('remove');
    await patch({ cardRemovedMs: 0, paymentCooldownMs: 60000 }, admin);
    await card('approach');
    assert.equal((await pay('timing-payment-short')).data.error, 'card_hold_required');
    await card('remove');
    await card('approach');
    assert.equal((await pay('timing-payment-cooldown')).data.error, 'payment_cooldown');
    await patch({ cardRemovedMs: 0, paymentCooldownMs: 0 }, admin);
    assert.equal((await pay('timing-payment-001')).data.settingsVersion, 2);
    assert.equal((await pay('timing-payment-still-wait')).data.error, 'payment_cooldown');
    const state = running.store.getDemoState();
    running.store.setDemoState({ cardUid: state.card_uid, present: state.present, removedAtMs: state.removed_at_ms, eligibleAtMs: state.eligible_at_ms, paymentLatched: state.payment_latched, lastPaymentAtMs: state.last_payment_at_ms, cooldownUntilMs: 0 });
    assert.equal((await pay('timing-payment-002')).data.approved, true);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 2500);
    assert.equal(running.store.summary().pulseCount, 3);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    assert.equal(running.store.getMachine('DEMO-MACHINE').card_removed_ms, 0);
    assert.equal(running.store.getMachine('DEVICE-B').card_removed_ms, 300);
    assert.equal(running.store.getMachine('DEVICE-B').settings_version, 2);
    assert.equal(running.store.getMachine('DEVICE-B').payment_cooldown_ms, 0);
    assert.equal(running.store.getDemoState('DEVICE-B').present, 1);
    assert.equal(running.store.getDemoState('DEVICE-B').payment_latched, 1);
  } finally { await running.close(); }
});

test('admin can suspend and restore staff without reviving old sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-staff-access-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const setup = await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' });
    const admin = setup.cookie;
    const created = await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staffId = created.data.user.id;
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    await demoTopup(base, { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '10', idempotencyKey: 'staff-access-topup-001' }, staff);
    const url = `/phase1/api/admin/staff/${staffId}/lock`;
    assert.equal((await post(url, { locked: true }, staff)).response.status, 403);
    assert.equal((await post(url, { locked: 'false' }, admin)).response.status, 400);
    assert.equal((await post(`/phase1/api/admin/staff/${setup.data.user.id}/lock`, { locked: true }, admin)).response.status, 400);
    assert.equal((await post(url, { locked: true }, admin)).data.user.locked, true);
    assert.equal((await jsonRequest(base, '/phase1/api/state', {}, staff)).response.status, 401);
    assert.equal((await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).response.status, 401);
    await post(url, { locked: true }, admin);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    const state = (await jsonRequest(base, '/phase1/api/state', {}, admin)).data;
    assert.equal(state.staff.find(user => user.id === staffId).locked, 1);
    assert.equal((await post(url, { locked: false }, admin)).data.user.locked, false);
    assert.equal((await jsonRequest(base, '/phase1/api/state', {}, staff)).response.status, 401);
    assert.equal((await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).response.status, 200);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 1000);
    assert.equal(running.store.listLedger().length, 1);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'staff.disabled'").get().n, 1);
    db.close();
  } finally { await running.close(); }
});

test('per-device demo LED settings and simulated version results persist independently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-led-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  const led = (id, body, cookie) => jsonRequest(base, `/phase1/api/machines/${id}/led`, { method: 'PATCH', body: JSON.stringify(body) }, cookie);
  const report = (id, body, cookie) => post(`/phase1/api/demo/machines/${id}/settings-result`, body, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    await post('/phase1/api/machines', { id: 'DEVICE-B', name: 'B', priceTl: '25' }, admin);
    assert.equal((await led('DEMO-MACHINE', { enabled: true, brightness: 20 }, staff)).response.status, 403);
    assert.equal((await led('DEMO-MACHINE', { enabled: 'true', brightness: 20 }, admin)).response.status, 400);
    assert.equal((await led('DEMO-MACHINE', { enabled: true, brightness: 256 }, admin)).response.status, 400);
    const a = (await led('DEMO-MACHINE', { enabled: true, brightness: 30 }, admin)).data.machine;
    const b = (await led('DEVICE-B', { enabled: false, brightness: 200 }, admin)).data.machine;
    assert.equal(a.settings_status, 'pending');
    assert.equal(b.settings_status, 'pending');
    assert.equal((await report('DEMO-MACHINE', { version: a.settings_version, status: 'applied' }, staff)).response.status, 403);
    assert.equal((await report('DEMO-MACHINE', { version: a.settings_version - 1, status: 'applied' }, admin)).response.status, 409);
    const applied = (await report('DEMO-MACHINE', { version: a.settings_version, status: 'applied' }, admin)).data.machine;
    assert.equal(applied.simulated_led_brightness, 30);
    assert.equal(applied.settings_status, 'applied');
    const failed = (await report('DEVICE-B', { version: b.settings_version, status: 'failed' }, admin)).data.machine;
    assert.equal(failed.settings_status, 'failed');
    assert.equal(failed.simulated_led_enabled, false);
    await demoTopup(base, { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '100', idempotencyKey: 'led-topup-001' }, admin);
    await post('/phase1/api/demo/simulator/card', { action: 'approach', cardUid: 'DEMO-0001' }, admin);
    const paymentBody = { cardUid: 'DEMO-0001', idempotencyKey: 'led-payment-001' };
    const paid = await post('/phase1/api/demo/payment', paymentBody, admin);
    assert.deepEqual(paid.data.demoLedSnapshot, { enabled: true, brightness: 30 });
    assert.deepEqual(paid.data.simulatedLedSnapshot, { version: a.settings_version, enabled: true, brightness: 30 });
    const changed = (await led('DEMO-MACHINE', { enabled: false, brightness: 0 }, admin)).data.machine;
    assert.equal(changed.settings_status, 'pending');
    assert.equal(changed.simulated_led_brightness, 30);
    assert.equal((await report('DEMO-MACHINE', { version: a.settings_version, status: 'applied' }, admin)).response.status, 409);
    assert.deepEqual((await post('/phase1/api/demo/payment', paymentBody, admin)).data.demoLedSnapshot, { enabled: true, brightness: 30 });
    assert.deepEqual((await post('/phase1/api/demo/payment', paymentBody, admin)).data.simulatedLedSnapshot, { version: a.settings_version, enabled: true, brightness: 30 });
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    const currentA = running.store.getMachine('DEMO-MACHINE');
    const currentB = running.store.getMachine('DEVICE-B');
    assert.equal(currentA.settings_status, 'pending');
    assert.equal(currentA.led_brightness, 0);
    assert.equal(currentA.simulated_led_brightness, 30);
    assert.equal(currentB.settings_status, 'failed');
    assert.equal(currentB.led_brightness, 200);
  } finally { await running.close(); }
});

test('demo staff password reset requires admin reauthentication, expires and is single-use', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-reset-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    const created = await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const id = created.data.user.id;
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    const issue = `/phase1/api/admin/staff/${id}/demo-password-reset`;
    assert.equal((await post(issue, { adminPassword: 'wrong password' }, admin)).response.status, 401);
    assert.equal((await post(issue, { adminPassword: 'correct horse battery staple' }, staff)).response.status, 403);
    assert.equal((await post(issue, { adminPassword: 'correct horse battery staple' })).response.status, 401);
    const first = await post(issue, { adminPassword: 'correct horse battery staple' }, admin);
    assert.equal(first.response.headers.get('cache-control'), 'no-store');
    assert.match(first.data.token, /^[a-f0-9]{64}$/);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databasePath);
    const key = `demo_password_reset:${id}`;
    const stored = JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(key).value);
    assert.notEqual(stored.tokenHash, first.data.token);
    stored.expiresAt = '2000-01-01T00:00:00.000Z';
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(stored), key);
    db.close();
    const complete = '/phase1/api/auth/demo-password-reset';
    assert.equal((await post(complete, { username: 'staff', token: first.data.token, newPassword: 'new password 123' })).response.status, 400);
    const issued = await post(issue, { adminPassword: 'correct horse battery staple' }, admin);
    const token = issued.data.token;
    assert.equal((await post(complete, { username: 'staff', token: '0'.repeat(64), newPassword: 'new password 123' })).response.status, 400);
    assert.equal((await post(complete, { username: 'staff', token, newPassword: 'short' })).response.status, 400);
    const response = await post(complete, { username: 'staff', token, newPassword: 'new password 123' });
    assert.equal(response.response.status, 200);
    assert.equal((await post(complete, { username: 'staff', token, newPassword: 'another password 123' })).response.status, 400);
    assert.equal((await jsonRequest(base, '/phase1/api/state', {}, staff)).response.status, 401);
    assert.equal((await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).response.status, 401);
    assert.equal((await post('/phase1/api/auth/login', { username: 'staff', password: 'new password 123' })).response.status, 200);
    const state = await jsonRequest(base, '/phase1/api/state', {}, admin);
    assert.equal(JSON.stringify(state.data).includes(token), false);
    assert.equal(JSON.stringify(state.data).includes('tokenHash'), false);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    assert.equal((await post(complete, { username: 'staff', token, newPassword: 'another password 123' })).response.status, 400);
    assert.equal((await post('/phase1/api/auth/login', { username: 'staff', password: 'new password 123' })).response.status, 200);
    const pending = await post(issue, { adminPassword: 'correct horse battery staple' }, admin);
    assert.equal((await post(`/phase1/api/admin/staff/${id}/lock`, { locked: true }, admin)).response.status, 200);
    assert.equal((await post(`/phase1/api/admin/staff/${id}/lock`, { locked: false }, admin)).response.status, 200);
    assert.equal((await post(complete, { username: 'staff', token: pending.data.token, newPassword: 'another password 123' })).response.status, 400);
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const audits = inspection.prepare('SELECT data_json FROM audit_log').all().map(entry => entry.data_json).join(' ');
    assert.equal(audits.includes(token), false);
    assert.equal(audits.includes('new password 123'), false);
    inspection.close();
  } finally { await running.close(); }
});

test('period report is admin-only and validates period', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-report-'));
  const running = startServer({ host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'demo.sqlite') });
  await new Promise(resolve => running.server.once('listening', resolve));
  const base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    assert.equal((await jsonRequest(base, '/phase1/api/report/period?period=day')).response.status, 401);
    assert.equal((await jsonRequest(base, '/phase1/api/report/period?period=day', {}, staff)).response.status, 403);
    assert.equal((await jsonRequest(base, '/phase1/api/report/period?period=bad', {}, admin)).response.status, 400);
    assert.equal((await jsonRequest(base, '/phase1/api/report/period?period=day&date=2026-02-30', {}, admin)).response.status, 400);
    assert.equal((await jsonRequest(base, '/phase1/api/report/period?period=day&date=2020-01-01', {}, staff)).response.status, 403);
    for (const period of ['day', 'week', 'month', 'year']) {
      const result = await jsonRequest(base, `/phase1/api/report/period?period=${period}`, {}, admin);
      assert.equal(result.response.status, 200);
      assert.equal(result.data.report.timezone, 'Europe/Istanbul');
      assert.equal(result.response.headers.get('cache-control'), 'no-store');
      const historic = await jsonRequest(base, `/phase1/api/report/period?period=${period}&date=2020-01-01`, {}, admin);
      assert.equal(historic.data.report.selectedDate, '2020-01-01');
    }
  } finally { await running.close(); }
});

test('CSV exports selected demo period safely in Turkish Excel format for admin only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-csv-'));
  const running = startServer({ host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'demo.sqlite') });
  await new Promise(resolve => running.server.once('listening', resolve));
  const base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    const store = running.store;
    store.createMachine({ id: 'TEST-CSV', name: ' =HYPERLINK("test";"çalıştır")', priceCents: 5000 });
    store.topUp({ accountId: 'demo-account', amountCents: 20000, idempotencyKey: 'csv-test-topup-001' });
    const payment = store.pay({ machineId: 'TEST-CSV', cardUid: 'DEMO-0001', idempotencyKey: 'csv-test-payment-001' });
    store.simulatePulse(payment.pulseCommandId, 'response_lost');
    store.correctBalance({ accountId: 'demo-account', amountCents: -1000, reason: 'Demo test düzeltmesi', idempotencyKey: 'csv-test-correction-001', actorUserId: null });
    const url = `${base}/phase1/api/report/period.csv?period=day`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Cookie: staff } })).status, 403);
    assert.equal((await fetch(`${url}&date=2026-02-30`, { headers: { Cookie: admin } })).status, 400);
    const response = await fetch(url, { headers: { Cookie: admin } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv.*utf-8/);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const csv = bytes.toString('utf8');
    assert.match(csv, /"Tutar \(TL\)"\r\n/);
    assert.match(csv, /"Yükleme";"";200,00/);
    assert.match(csv, /"Oyun harcaması";"";50,00/);
    assert.match(csv, /"Net bakiye düzeltmesi";"";-10,00/);
    assert.match(csv, /"Şu anki toplam bakiye; dönem sonu bakiyesi değildir";"";140,00/);
    assert.match(csv, /"Belirsiz";"";50,00/);
    assert.ok(csv.includes('"\'=HYPERLINK(""test"";""çalıştır"")";"TEST-CSV";50,00'));
    const old = await fetch(`${url}&date=2020-01-01`, { headers: { Cookie: admin } });
    const oldCsv = await old.text();
    assert.ok(oldCsv.includes('2020-01-01'));
    assert.match(oldCsv, /"Oyun harcaması";"";0,00/);
    assert.ok(!oldCsv.includes('TEST-CSV'));
  } finally { await running.close(); }
});

test('CSV neutralizes formula prefixes and quotes untrusted device names', () => {
  const { reportCsv } = require('../server');
  const names = ['=1+1', '+1', '-1', '@SUM(1)', ' \t=1', '\ttext', 'safe;"quoted"\nline'];
  const csv = reportCsv({ selectedDate: '2026-01-01', period: 'day', start: '2026-01-01', end: '2026-01-02', totals: { topups_cents: 0, game_charges_cents: 0, corrections_cents: 0 }, balance_cents: 0, commandStatus: { ambiguous: 0, pending: 0, failed: 0, missing: 0, succeeded: 0 }, machines: names.map((name, i) => ({ name, machine_id: `M${i}`, cents: 0 })) }, new Date('2026-01-01T00:00:00Z'));
  for (const name of names.slice(0, 6)) assert.ok(csv.includes('"\'' + name + '"'));
  assert.ok(csv.includes('"safe;""quoted""\nline"'));
});

test('admin sees persisted simulated command history and staff cannot obtain it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-pulse-history-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    await demoTopup(base, { accountId: 'demo-account', amountTl: '50', idempotencyKey: 'pulse-view-topup-001' }, admin);
    await post('/phase1/api/demo/simulator/card', { action: 'approach', cardUid: 'DEMO-0001' }, admin);
    const payment = await post('/phase1/api/demo/payment', { cardUid: 'DEMO-0001', machineId: 'DEMO-MACHINE', idempotencyKey: 'pulse-view-payment-001' }, admin);
    await post(`/phase1/api/demo/pulse/${payment.data.pulseCommandId}/simulate`, { outcome: 'response_lost' }, admin);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    const state = (await jsonRequest(base, '/phase1/api/state', {}, admin)).data;
    assert.equal(state.pulses.length, 1);
    assert.equal(state.pulses[0].id, payment.data.pulseCommandId);
    assert.equal(state.pulses[0].status, 'ambiguous');
    assert.equal(state.pulses[0].machine_id, 'DEMO-MACHINE');
    assert.equal(state.pulses[0].amount_cents, 2500);
    assert.deepEqual((await jsonRequest(base, '/phase1/api/state', {}, staff)).data.pulses, []);
  } finally { await running.close(); }
});

test('admin detailed history filters, paginates and exports safely without truncation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-details-'));
  const running = startServer({ host: '127.0.0.1', port: 0, databasePath: path.join(dir, 'demo.sqlite') });
  await new Promise(resolve => running.server.once('listening', resolve));
  const base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    const store = running.store;
    store.createMachine({ id: 'DEVICE-B', name: '=1+1', priceCents: 2500 });
    for (let i = 0; i < 27; i++) store.topUp({ accountId: 'demo-account', amountCents: 1000, idempotencyKey: `details-topup-${String(i).padStart(3, '0')}` });
    store.pay({ machineId: 'DEVICE-B', cardUid: 'DEMO-0001', idempotencyKey: 'details-payment-001' });
    store.correctBalance({ accountId: 'demo-account', amountCents: -100, reason: 'Test düzeltme gerekçesi', idempotencyKey: 'details-correction-001', actorUserId: null });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(store.dbPath);
    db.prepare('UPDATE ledger_entries SET created_at = ?').run('2016-03-26T22:00:00.000Z');
    db.prepare('UPDATE ledger_entries SET created_at = ? WHERE idempotency_key = ?').run('2016-03-26T21:59:59.000Z', 'details-topup-000:ledger');
    const endpoint = '/phase1/api/admin/history/details';
    assert.equal((await jsonRequest(base, endpoint)).response.status, 401);
    assert.equal((await jsonRequest(base, endpoint, {}, staff)).response.status, 403);
    assert.equal((await fetch(`${base}${endpoint}.csv`, { headers: { Cookie: staff } })).status, 403);
    assert.equal((await jsonRequest(base, `${endpoint}?from=2026-02-30`, {}, admin)).response.status, 400);
    assert.equal((await jsonRequest(base, `${endpoint}?from=2026-01-02&to=2026-01-01`, {}, admin)).response.status, 400);
    assert.equal((await jsonRequest(base, `${endpoint}?type=unknown`, {}, admin)).response.status, 400);
    assert.equal((await jsonRequest(base, `${endpoint}?page=0`, {}, admin)).response.status, 400);
    const query = '?from=2016-03-27&to=2016-03-27';
    const first = await jsonRequest(base, endpoint + query, {}, admin);
    const second = await jsonRequest(base, endpoint + query + '&page=2', {}, admin);
    assert.equal(first.data.total, 28);
    assert.equal(first.data.rows.length, 25);
    assert.equal(second.data.rows.length, 3);
    assert.equal(new Set([...first.data.rows, ...second.data.rows].map(row => row.id)).size, 28);
    const filtered = await jsonRequest(base, endpoint + query + '&machineId=DEVICE-B&type=game_charge', {}, admin);
    assert.equal(filtered.data.total, 1);
    assert.equal(filtered.data.rows[0].amount_cents, -2500);
    assert.equal((await jsonRequest(base, endpoint + query + '&machineId=DEVICE-B&type=topup', {}, admin)).data.total, 0);
    const csvResponse = await fetch(`${base}${endpoint}.csv${query}`, { headers: { Cookie: admin } });
    assert.equal(csvResponse.status, 200);
    const bytes = Buffer.from(await csvResponse.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const csv = bytes.toString('utf8');
    assert.ok(csv.includes('İşlem sonrası hesap bakiyesi (TL)'));
    assert.ok(csv.includes('"\'=1+1"'));
    assert.ok(csv.includes(';"game_charge";-25,00;'));
    assert.equal(csv.trimEnd().split('\r\n').length, 29);
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 5001)
      INSERT INTO ledger_entries(id, account_id, entry_type, amount_cents, balance_after_cents, idempotency_key, created_at)
      SELECT 'synthetic-' || x, 'demo-account', 'topup', 1, 1, 'synthetic-key-' || x, '2010-01-01T00:00:00.000Z' FROM n`);
    db.close();
    const tooMany = await fetch(`${base}${endpoint}.csv`, { headers: { Cookie: admin } });
    assert.equal(tooMany.status, 400);
    assert.equal((await tooMany.json()).error, 'export_limit');
  } finally { await running.close(); }
});

test('lost topup response can only be retried by original user after restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-topup-owner-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    const body = { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '20', idempotencyKey: 'topup-owner-test-001' };
    const first = await demoTopup(base, body, staff);
    assert.equal(first.response.status, 201);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    assert.equal((await demoTopup(base, body)).response.status, 401);
    assert.equal((await demoTopup(base, body, admin)).response.status, 403);
    assert.equal((await demoTopup(base, { ...body, amountTl: '21' }, staff)).response.status, 409);
    const retry = await demoTopup(base, body, staff);
    assert.equal(retry.response.status, 200);
    assert.equal(retry.data.duplicate, true);
    assert.equal(retry.data.entryId, first.data.entryId);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 2000);
    assert.equal(running.store.listLedger().filter(entry => entry.entry_type === 'topup').length, 1);
  } finally { await running.close(); }
});

test('admin-only read-only topup lookup reports confirmed, unknown and inconsistent results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-lookup-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    const endpoint = '/phase1/api/admin/topups/lookup';
    const key = 'topup-lookup-test-001';
    assert.equal((await post(endpoint, { idempotencyKey: key })).response.status, 401);
    assert.equal((await post(endpoint, { idempotencyKey: key }, staff)).response.status, 403);
    assert.equal((await post(endpoint, { idempotencyKey: 'bad' }, admin)).response.status, 400);
    assert.equal((await post(endpoint, { idempotencyKey: key }, admin)).data.status, 'unknown');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databasePath);
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO idempotency_keys(idempotency_key,operation,request_hash,response_json,created_at) VALUES (?, 'topup', 'test', '{}', ?)").run(key, new Date().toISOString());
    assert.equal((await post(endpoint, { idempotencyKey: key }, admin)).data.status, 'unknown');
    db.exec('ROLLBACK');
    const body = { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '25', idempotencyKey: key };
    const first = await demoTopup(base, body, staff);
    const priorCount = running.store.summary().ledger_count;
    const found = await post(endpoint, { idempotencyKey: key }, admin);
    assert.equal(found.response.headers.get('cache-control'), 'no-store');
    assert.equal(found.data.status, 'recorded');
    assert.equal(found.data.entry.id, first.data.entryId);
    assert.equal(found.data.entry.amount_cents, 2500);
    assert.equal(found.data.entry.actor, 'staff');
    assert.equal(running.store.summary().ledger_count, priorCount);
    const saved = db.prepare('SELECT response_json FROM idempotency_keys WHERE idempotency_key = ?').get(key).response_json;
    db.prepare('UPDATE idempotency_keys SET response_json = ? WHERE idempotency_key = ?').run('{}', key);
    assert.equal((await post(endpoint, { idempotencyKey: key }, admin)).data.status, 'inconsistent');
    db.prepare('UPDATE idempotency_keys SET response_json = ? WHERE idempotency_key = ?').run(saved, key);
    db.close();
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    assert.equal((await post(endpoint, { idempotencyKey: key }, admin)).data.status, 'recorded');
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 2500);
    assert.equal(running.store.summary().ledger_count, priorCount);
  } finally { await running.close(); }
});

test('reasoned admin demo free play is atomic, idempotent and separate from paid reports', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-free-play-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    const endpoint = '/phase1/api/admin/demo/free-play';
    const body = { machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', reason: 'Demo amaçlı ücretsiz deneme', idempotencyKey: 'freeplay-demo-test-001' };
    assert.equal((await post(endpoint, body)).response.status, 401);
    assert.equal((await post(endpoint, body, staff)).response.status, 403);
    assert.equal((await post(endpoint, { ...body, reason: 'short' }, admin)).response.status, 400);
    assert.equal((await post(endpoint, body, admin)).data.error, 'card_not_present');
    assert.equal(running.store.summary().pulseCount, 0);
    await demoTopup(base, { accountId: 'demo-account', amountTl: '100', idempotencyKey: 'freeplay-topup-test-001' }, admin);
    await post('/phase1/api/demo/simulator/card', { action: 'approach', cardUid: 'DEMO-0001' }, admin);
    const first = await post(endpoint, body, admin);
    assert.equal(first.response.status, 201);
    assert.equal(first.data.balanceAfterCents, 10000);
    assert.equal(running.store.getPulseCommand(first.data.pulseCommandId).amount_cents, 0);
    assert.equal((await post(endpoint, body, admin)).data.duplicate, true);
    assert.equal((await post(endpoint, { ...body, reason: 'Farklı geçerli gerekçe' }, admin)).response.status, 409);
    assert.equal((await post(endpoint, { ...body, idempotencyKey: 'freeplay-held-test-001' }, admin)).data.error, 'card_hold_required');
    assert.equal(running.store.summary().pulseCount, 1);
    const state = (await jsonRequest(base, '/phase1/api/state', {}, admin)).data;
    assert.equal(state.summary.topups_cents, 10000);
    assert.equal(state.summary.game_charges_cents, 0);
    assert.equal(state.summary.free_plays_count, 1);
    assert.equal(state.ledger.find(entry => entry.id === first.data.entryId).entry_type, 'free_play');
    assert.equal(state.ledger.find(entry => entry.id === first.data.entryId).note, body.reason);
    const report = (await jsonRequest(base, '/phase1/api/report/period?period=day', {}, admin)).data.report;
    assert.equal(report.totals.free_plays_count, 1);
    assert.equal(report.totals.game_charges_cents, 0);
    const csv = await (await fetch(`${base}/phase1/api/report/period.csv?period=day`, { headers: { Cookie: admin } })).text();
    assert.ok(csv.includes('Ücretsiz demo oyun adedi'));
    await post(`/phase1/api/demo/pulse/${first.data.pulseCommandId}/simulate`, { outcome: 'response_lost' }, admin);
    assert.equal((await post(`/phase1/api/demo/pulse/${first.data.pulseCommandId}/retry`, {}, admin)).response.status, 409);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    const retry = await post(endpoint, body, admin);
    assert.equal(retry.data.duplicate, true);
    assert.equal(retry.data.pulseCommandId, first.data.pulseCommandId);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 10000);
    assert.equal(running.store.summary().pulseCount, 1);
    assert.equal(running.store.getPulseCommand(first.data.pulseCommandId).status, 'ambiguous');
  } finally { await running.close(); }
});

test('demo free play rolls back ledger if simulated command insert fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-free-rollback-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  const running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  const base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/demo/simulator/card', { action: 'approach', cardUid: 'DEMO-0001' }, admin);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TRIGGER demo_fail_pulse BEFORE INSERT ON pulse_commands BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END");
    db.close();
    const actor = (await jsonRequest(base, '/phase1/api/state', {}, admin)).data.user.id;
    assert.throws(() => running.store.demoFreePlay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', reason: 'Demo başarısızlık testi', idempotencyKey: 'freeplay-rollback-001', actorUserId: actor }), /simulated insert failure/);
    assert.equal(running.store.summary().free_plays_count, 0);
    assert.equal(running.store.summary().pulseCount, 0);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 0);
    assert.equal(running.store.getIdempotency('freeplay-rollback-001'), null);
    assert.equal(running.store.getDemoState('DEMO-MACHINE').payment_latched, 0);
  } finally { await running.close(); }
});

test('recorded topup review respects actor and exposes the different-key concurrency risk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-recorded-review-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    for (const username of ['staff1', 'staff2']) await post('/phase1/api/admin/users', { username, password: 'staff password 1', role: 'staff' }, admin);
    const staff1 = (await post('/phase1/api/auth/login', { username: 'staff1', password: 'staff password 1' })).cookie;
    const staff2 = (await post('/phase1/api/auth/login', { username: 'staff2', password: 'staff password 1' })).cookie;
    const body = { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '10', idempotencyKey: 'review-same-key-001' };
    const same = await Promise.all([demoTopup(base, body, staff1), demoTopup(base, body, staff1)]);
    assert.deepEqual(same.map(result => result.response.status).sort(), [200, 201]);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 1000);
    const different = await Promise.all(['review-different-001', 'review-different-002'].map(key => demoTopup(base, { ...body, idempotencyKey: key }, staff1)));
    assert.deepEqual(different.map(result => result.response.status), [201, 201]);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 3000);
    await demoTopup(base, { ...body, idempotencyKey: 'review-other-user-001' }, staff2);
    const url = '/phase1/api/demo/topups/recorded';
    assert.equal((await jsonRequest(base, url)).response.status, 401);
    const own = await jsonRequest(base, url, {}, staff1);
    assert.equal(own.response.headers.get('cache-control'), 'no-store');
    assert.equal(own.data.records.length, 3);
    assert.ok(own.data.records.every(record => record.entry.actor === 'staff1'));
    assert.ok(!own.data.records.some(record => record.request_key === 'review-other-user-001'));
    assert.equal((await jsonRequest(base, url, {}, staff2)).data.records.length, 1);
    assert.equal((await jsonRequest(base, url, {}, admin)).data.records.length, 4);
    const before = running.store.summary().ledger_count;
    await jsonRequest(base, url, {}, staff1);
    assert.equal(running.store.summary().ledger_count, before);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    assert.equal((await jsonRequest(base, url, {}, staff1)).data.records.length, 3);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 4000);
  } finally { await running.close(); }
});

test('server demo intent survives restart, binds owner and payload, and two clients execute it once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-intent-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staffA = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    const staffB = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    const body = { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '10', idempotencyKey: 'topup-intent-test-001' };
    const prepare = '/phase1/api/demo/topup-intents';
    const execute = '/phase1/api/demo/topup-intents/execute';
    assert.equal((await post(prepare, body)).response.status, 401);
    assert.equal((await post(prepare, body, staffA)).response.status, 201);
    assert.equal((await post(prepare, body, staffB)).data.duplicate, true);
    assert.equal((await post(prepare, { ...body, amountTl: '11' }, staffA)).response.status, 409);
    assert.equal((await post(prepare, body, admin)).response.status, 403);
    assert.equal((await post(execute, { intentId: body.idempotencyKey }, admin)).response.status, 403);
    assert.equal((await jsonRequest(base, prepare, {}, admin)).data.intents.length, 0);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 0);
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    const open = await jsonRequest(base, prepare, {}, staffB);
    assert.equal(open.data.intents.length, 1);
    assert.equal(open.data.intents[0].id, body.idempotencyKey);
    assert.equal(open.response.headers.get('cache-control'), 'no-store');
    const first = await Promise.all([post(execute, { intentId: body.idempotencyKey, attemptId: 'first' }, staffA), post(execute, { intentId: body.idempotencyKey, attemptId: 'second' }, staffB)]);
    assert.deepEqual(first.map(result => result.response.status).sort(), [200, 201]);
    assert.equal(first[0].data.entryId, first[1].data.entryId);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 1000);
    assert.equal((await jsonRequest(base, prepare, {}, staffA)).data.intents.length, 0);
    assert.equal((await post(execute, { intentId: 'topup-never-arrived-001' }, staffA)).data.error, 'intent_unknown');
    const secondBody = { ...body, idempotencyKey: 'topup-intent-test-002' };
    assert.equal((await post(prepare, secondBody, staffA)).response.status, 201);
    assert.equal((await post(execute, { intentId: secondBody.idempotencyKey }, staffA)).response.status, 201);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 2000);
    const legacyBody = { ...body, idempotencyKey: 'topup-intent-legacy-001' };
    const staffId = (await jsonRequest(base, '/phase1/api/state', {}, staffA)).data.user.id;
    running.store.topUp({ accountId: legacyBody.accountId, cardUid: legacyBody.cardUid, amountCents: 1000, idempotencyKey: legacyBody.idempotencyKey, actorUserId: staffId });
    const migrated = await post(prepare, legacyBody, staffA);
    assert.equal(migrated.data.intent.status, 'completed');
    assert.equal((await post(execute, { intentId: legacyBody.idempotencyKey }, staffA)).data.duplicate, true);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 3000);
  } finally { await running.close(); }
});

test('direct demo API requires intent for new topups but safely confirms old recorded requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-intent-required-'));
  const databasePath = path.join(dir, 'demo.sqlite');
  let running = startServer({ host: '127.0.0.1', port: 0, databasePath });
  await new Promise(resolve => running.server.once('listening', resolve));
  let base = `http://127.0.0.1:${running.server.address().port}`;
  const post = (url, body, cookie) => jsonRequest(base, url, { method: 'POST', body: JSON.stringify(body) }, cookie);
  try {
    const admin = (await post('/phase1/api/setup', { username: 'admin', password: 'correct horse battery staple' })).cookie;
    await post('/phase1/api/admin/users', { username: 'staff', password: 'staff password 1', role: 'staff' }, admin);
    const staff = (await post('/phase1/api/auth/login', { username: 'staff', password: 'staff password 1' })).cookie;
    const actor = (await jsonRequest(base, '/phase1/api/state', {}, staff)).data.user.id;
    const route = '/phase1/api/topups';
    const body = { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '10', idempotencyKey: 'topup-no-intent-001' };
    const rejected = await Promise.all([post(route, body, staff), post(route, { ...body, idempotencyKey: 'topup-no-intent-002' }, staff)]);
    assert.ok(rejected.every(result => result.response.status === 409 && result.data.error === 'intent_required'));
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 0);
    assert.equal(running.store.summary().ledger_count, 0);
    const intent = { ...body, idempotencyKey: 'topup-required-intent-001' };
    assert.equal((await post('/phase1/api/demo/topup-intents', intent, staff)).response.status, 201);
    assert.equal((await post(route, { ...intent, amountTl: '11' }, staff)).response.status, 409);
    assert.equal((await post(route, intent, admin)).response.status, 409);
    const same = await Promise.all([post(route, intent, staff), post('/phase1/api/demo/topup-intents/execute', { intentId: intent.idempotencyKey }, staff)]);
    assert.deepEqual(same.map(result => result.response.status).sort(), [200, 201]);
    assert.equal(same[0].data.entryId, same[1].data.entryId);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 1000);
    const second = { ...intent, idempotencyKey: 'topup-required-intent-002' };
    assert.equal((await post('/phase1/api/demo/topup-intents', second, staff)).response.status, 201);
    assert.equal((await post(route, second, staff)).response.status, 201);
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 2000);
    const legacy = { ...body, idempotencyKey: 'topup-legacy-recorded-001' };
    const old = running.store.topUp({ accountId: legacy.accountId, cardUid: legacy.cardUid, amountCents: 1000, idempotencyKey: legacy.idempotencyKey, actorUserId: actor });
    await running.close();
    running = startServer({ host: '127.0.0.1', port: 0, databasePath });
    await new Promise(resolve => running.server.once('listening', resolve));
    base = `http://127.0.0.1:${running.server.address().port}`;
    const confirmed = await post(route, legacy, staff);
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.data.duplicate, true);
    assert.equal(confirmed.data.entryId, old.entryId);
    assert.equal((await post(route, legacy, admin)).response.status, 403);
    assert.equal((await post(route, { ...legacy, amountTl: '11' }, staff)).response.status, 409);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databasePath);
    const saved = db.prepare('SELECT response_json FROM idempotency_keys WHERE idempotency_key = ?').get(legacy.idempotencyKey).response_json;
    const broken = { ...JSON.parse(saved), balanceAfterCents: 99999 };
    db.prepare('UPDATE idempotency_keys SET response_json = ? WHERE idempotency_key = ?').run(JSON.stringify(broken), legacy.idempotencyKey);
    assert.equal((await post(route, legacy, staff)).data.error, 'topup_history_inconsistent');
    assert.equal((await post('/phase1/api/demo/topup-intents', legacy, staff)).data.error, 'topup_history_inconsistent');
    db.prepare('UPDATE idempotency_keys SET response_json = ? WHERE idempotency_key = ?').run('{', legacy.idempotencyKey);
    assert.equal((await post(route, legacy, staff)).data.error, 'idempotency_corrupt');
    db.prepare('UPDATE idempotency_keys SET response_json = ? WHERE idempotency_key = ?').run(saved, legacy.idempotencyKey);
    db.close();
    assert.equal(running.store.getAccount('demo-account').tl_balance_cents, 3000);
    assert.equal(running.store.summary().ledger_count, 3);
  } finally { await running.close(); }
});
