'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createStore } = require('../core');

for (const point of ['after_balance', 'before_commit', 'after_commit']) {
  test(`process crash ${point} preserves atomic payment and retry`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-crash-'));
    const dbPath = path.join(dir, 'demo.sqlite');
    const store = createStore(dbPath);
    store.topUp({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountCents: 20000, idempotencyKey: 'crash-topup-001' });
    store.setDemoState({ cardUid: 'DEMO-0001', present: true });
    store.close();
    const script = `const {createStore}=require(${JSON.stringify(path.resolve(__dirname, '../core'))});
      const s=createStore(process.argv[1], {testHook: p => { if(p===process.argv[2]) process.kill(process.pid,'SIGKILL'); }});
      s.pay({machineId:'DEMO-MACHINE',cardUid:'DEMO-0001',idempotencyKey:'crash-payment-001',simulator:true});
      process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ['-e', script, dbPath, point]);
    assert.equal(child.signal, 'SIGKILL');
    const reopened = createStore(dbPath);
    try {
      const committed = point === 'after_commit';
      assert.equal(reopened.getAccount('demo-account').tl_balance_cents, committed ? 17500 : 20000);
      assert.equal(reopened.summary().pulseCount, committed ? 1 : 0);
      assert.equal(reopened.getDemoState().payment_latched, committed ? 1 : 0);
      const result = reopened.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'crash-payment-001', simulator: true });
      assert.equal(Boolean(result.duplicate), committed);
      assert.equal(reopened.getAccount('demo-account').tl_balance_cents, 17500);
      assert.equal(reopened.summary().pulseCount, 1);
      assert.throws(() => reopened.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'crash-new-payment-001', simulator: true }), /kartı çekip/i);
    } finally { reopened.close(); }
  });
}
