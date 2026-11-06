'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createStore } = require('../core');

for (const point of ['topup_after_balance', 'topup_after_commit']) {
  test(`server topup intent survives process stop at ${point}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-intent-crash-'));
    const db = path.join(dir, 'demo.sqlite');
    const store = createStore(db);
    const user = store.createUser({ username: 'demo-admin', password: 'demo password 123', role: 'admin' });
    const key = 'topup-crash-intent-001';
    store.prepareDemoTopupIntent({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountCents: 2500, idempotencyKey: key, actorUserId: user.id });
    store.close();
    const code = `const { createStore } = require(process.argv[1]);
      const s = createStore(process.argv[2], { testHook: p => { if (p === process.argv[3]) process.exit(86); } });
      s.executeDemoTopupIntent(process.argv[4], process.argv[5]); process.exit(0);`;
    const worker = spawnSync(process.execPath, ['-e', code, path.join(__dirname, '../core.js'), db, point, key, user.id], { encoding: 'utf8', timeout: 10000 });
    assert.equal(worker.status, 86, worker.stderr);
    const reopened = createStore(db);
    try {
      const committed = point === 'topup_after_commit';
      assert.equal(reopened.getAccount('demo-account').tl_balance_cents, committed ? 2500 : 0);
      assert.equal(reopened.listDemoTopupIntents(user.id).length, committed ? 0 : 1);
      const retry = reopened.executeDemoTopupIntent(key, user.id);
      assert.equal(Boolean(retry.duplicate), committed);
      assert.equal(reopened.getAccount('demo-account').tl_balance_cents, 2500);
      assert.equal(reopened.listLedger().filter(row => row.entry_type === 'topup').length, 1);
    } finally { reopened.close(); }
  });
}

test('disabled intent owner cannot execute until restored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-intent-lock-'));
  const store = createStore(path.join(dir, 'demo.sqlite'));
  try {
    const admin = store.createUser({ username: 'admin', password: 'demo password 123', role: 'admin' });
    const staff = store.createUser({ username: 'staff', password: 'demo password 123', role: 'staff' });
    const key = 'topup-disabled-intent-001';
    store.prepareDemoTopupIntent({ accountId: 'demo-account', amountCents: 1000, idempotencyKey: key, actorUserId: staff.id });
    store.setStaffLocked(staff.id, true, admin.id);
    assert.throws(() => store.executeDemoTopupIntent(key, staff.id), /etkin değil/);
    assert.equal(store.getAccount('demo-account').tl_balance_cents, 0);
    assert.equal(store.listDemoTopupIntents(staff.id).length, 1);
    store.setStaffLocked(staff.id, false, admin.id);
    assert.equal(store.executeDemoTopupIntent(key, staff.id).balanceAfterCents, 1000);
  } finally { store.close(); }
});
