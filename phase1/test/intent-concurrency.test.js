'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../core');

if (process.env.OPENCREDIT_INTENT_WORKER === '1') {
  const store = createStore(process.argv[2]);
  process.send({ event: 'ready' });
  process.on('message', () => {
    process.send({ event: 'attempting' });
    try { process.send({ event: 'result', value: store.executeDemoTopupIntent(process.argv[3], process.argv[4]) }); }
    catch (error) { process.send({ event: 'error', error: error.message }); }
    store.close(); process.disconnect();
  });
} else {
  function event(child, name) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker timeout: ${name}`)); }, 8000);
      function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); }
      function onMessage(message) { if (message.event === 'error') { cleanup(); reject(new Error(message.error)); } else if (message.event === name) { cleanup(); resolve(message); } }
      function onExit(code, signal) { cleanup(); reject(new Error(`Worker exited before ${name}: ${code || signal}`)); }
      child.on('message', onMessage); child.on('exit', onExit);
    });
  }
  test('two independent processes execute the same server topup intent once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-intent-race-'));
    const dbPath = path.join(dir, 'demo.sqlite');
    const setup = createStore(dbPath);
    const user = setup.createUser({ username:'demo-admin', password:'demo password 123', role:'admin' });
    const key = 'topup-process-intent-001';
    setup.prepareDemoTopupIntent({ accountId:'demo-account', cardUid:'DEMO-0001', amountCents:2500, idempotencyKey:key, actorUserId:user.id });
    setup.close();
    const child = () => fork(__filename, [dbPath, key, user.id], { env:{...process.env, OPENCREDIT_INTENT_WORKER:'1'}, stdio:['ignore', 'ignore', 'pipe', 'ipc'] });
    const a = child(), b = child();
    let locker;
    try {
      await Promise.all([event(a, 'ready'), event(b, 'ready')]);
      locker = new DatabaseSync(dbPath); locker.exec('BEGIN IMMEDIATE');
      const attempted = Promise.all([event(a, 'attempting'), event(b, 'attempting')]);
      const results = Promise.all([event(a, 'result'), event(b, 'result')]);
      a.send('execute'); b.send('execute'); await attempted;
      locker.exec('COMMIT'); locker.close(); locker = null;
      const values = (await results).map(result => result.value);
      assert.deepEqual(values.map(value => Boolean(value.duplicate)).sort(), [false, true]);
      assert.equal(values[0].entryId, values[1].entryId);
      const reopened = createStore(dbPath);
      try {
        assert.equal(reopened.getAccount('demo-account').tl_balance_cents, 2500);
        assert.equal(reopened.listLedger().filter(row => row.entry_type === 'topup').length, 1);
        assert.equal(reopened.listDemoTopupIntents(user.id).length, 0);
      } finally { reopened.close(); }
    } finally {
      if (locker) { locker.exec('ROLLBACK'); locker.close(); }
      if (a.connected) a.kill(); if (b.connected) b.kill();
    }
  });
}
