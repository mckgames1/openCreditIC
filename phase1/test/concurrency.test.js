'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../core');

if (process.env.OPEN_CREDIT_RACE_WORKER === '1') {
  const isFirst = process.argv[3] === 'A';
  const store = createStore(process.argv[2], { testHook: point => {
    if (isFirst && point === 'after_balance') {
      process.send({ event: 'lock-held' });
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    }
  } });
  process.send({ event: 'ready' });
  process.on('message', message => {
    if (message !== 'pay') return;
    process.send({ event: 'attempting' });
    try {
      const result = store.pay({ machineId: isFirst ? 'DEVICE-A' : 'DEVICE-B', cardUid: 'DEMO-0001', idempotencyKey: `race-payment-${isFirst ? 'A' : 'B'}` });
      process.send({ event: 'result', result });
    } catch (error) { process.send({ event: 'error', error: error.message }); }
    store.close();
    process.disconnect();
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

  test('independent device processes contend for one 25 TL balance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-race-'));
    const databasePath = path.join(dir, 'demo.sqlite');
    const setup = createStore(databasePath);
    setup.createMachine({ id: 'DEVICE-A', name: 'Device A', priceCents: 2500 });
    setup.createMachine({ id: 'DEVICE-B', name: 'Device B', priceCents: 2500 });
    setup.topUp({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountCents: 2500, idempotencyKey: 'race-topup-001' });
    setup.close();
    const worker = id => fork(__filename, [databasePath, id], { env: { ...process.env, OPEN_CREDIT_RACE_WORKER: '1' }, stdio: ['pipe', 'ignore', 'pipe', 'ipc'] });
    const a = worker('A');
    const b = worker('B');
    try {
      await Promise.all([event(a, 'ready'), event(b, 'ready')]);
      const locked = event(a, 'lock-held');
      a.send('pay');
      await locked;
      let bFinished = false;
      const attempted = event(b, 'attempting');
      const bResult = event(b, 'result').then(value => { bFinished = true; return value; });
      b.send('pay');
      await attempted;
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(bFinished, false, 'second connection must wait for the first transaction');
      const aResult = event(a, 'result');
      a.stdin.write('x');
      const [first, second] = await Promise.all([aResult, bResult]);
      assert.equal(first.result.approved, true);
      assert.equal(second.result.approved, false);
      assert.equal(second.result.reason, 'insufficient_balance');
      const reopened = createStore(databasePath);
      try {
        assert.equal(reopened.getAccount('demo-account').tl_balance_cents, 0);
        assert.equal(reopened.summary().pulseCount, 1);
        assert.equal(reopened.listLedger().filter(entry => entry.entry_type === 'game_charge').length, 1);
        for (const [machineId, key, approved] of [['DEVICE-A', 'race-payment-A', true], ['DEVICE-B', 'race-payment-B', false]]) {
          const repeat = reopened.pay({ machineId, cardUid: 'DEMO-0001', idempotencyKey: key });
          assert.equal(repeat.duplicate, true);
          assert.equal(repeat.approved, approved);
        }
        assert.equal(reopened.summary().pulseCount, 1);
      } finally { reopened.close(); }
      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(inspection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(inspection.prepare('PRAGMA foreign_key_check').all().length, 0);
      inspection.close();
    } finally {
      if (a.connected) a.kill();
      if (b.connected) b.kill();
    }
  });
}
