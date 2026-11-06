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
    await jsonRequest(base, '/phase1/api/topups', { method: 'POST', body: JSON.stringify({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '200', idempotencyKey: 'machine-topup-001' }) }, cookie);
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
    const first = await post('/phase1/api/topups', topup, staff1);
    assert.equal(first.response.status, 201);
    assert.equal((await post('/phase1/api/topups', topup, staff1)).data.duplicate, true);
    await post('/phase1/api/topups', { ...topup, idempotencyKey: 'staff2-topup-001' }, staff2);
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
    await post('/phase1/api/topups', { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '200', idempotencyKey: 'correction-topup-001' }, admin);
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
    await post('/phase1/api/topups', { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '25', idempotencyKey: 'card-lock-topup-001' }, admin);
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
    await post('/phase1/api/topups', { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '200', idempotencyKey: 'attach-topup-001' }, admin);
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
