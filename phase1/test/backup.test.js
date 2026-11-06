'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createStore } = require('../core');

test('live WAL snapshot restores to new file with payment, command and idempotency intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-backup-'));
  const source = path.join(dir, 'live.sqlite');
  const backup = path.join(dir, 'backup.sqlite');
  const restored = path.join(dir, 'restored.sqlite');
  const store = createStore(source);
  try {
    store.topUp({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountCents: 20000, idempotencyKey: 'backup-topup-001' });
    const payment = store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'backup-payment-001' });
    assert.equal(fs.existsSync(`${source}-wal`), true);
    const script = name => path.resolve(__dirname, '../scripts', name);
    const backupRun = spawnSync(process.execPath, [script('backup.js'), '--database', source, '--output', backup], { encoding: 'utf8' });
    assert.equal(backupRun.status, 0, backupRun.stderr);
    const restoreRun = spawnSync(process.execPath, [script('restore.js'), '--source', backup, '--output', restored], { encoding: 'utf8' });
    assert.equal(restoreRun.status, 0, restoreRun.stderr);
    const copy = createStore(restored);
    try {
      assert.equal(copy.getAccount('demo-account').tl_balance_cents, 17500);
      assert.equal(copy.getPulseCommand(payment.pulseCommandId).status, 'pending');
      assert.equal(copy.listLedger().length, 2);
      assert.equal(copy.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'backup-payment-001' }).duplicate, true);
      assert.equal(copy.summary().pulseCount, 1);
    } finally { copy.close(); }
    const original = fs.readFileSync(backup);
    const refused = spawnSync(process.execPath, [script('restore.js'), '--source', backup, '--output', source], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.deepEqual(fs.readFileSync(backup), original);
    assert.equal(store.getAccount('demo-account').tl_balance_cents, 17500);
  } finally { store.close(); }
});

test('snapshot refuses missing or unrelated source and existing sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-backup-invalid-'));
  const { snapshot } = require('../scripts/snapshot');
  const missing = path.join(dir, 'missing.sqlite');
  assert.throws(() => snapshot(missing, path.join(dir, 'copy.sqlite')), /bulunamadı/);
  assert.equal(fs.existsSync(missing), false);
  const unrelated = path.join(dir, 'unrelated.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const other = new DatabaseSync(unrelated);
  other.exec('CREATE TABLE unrelated (id INTEGER)');
  other.close();
  assert.throws(() => snapshot(unrelated, path.join(dir, 'unrelated-copy.sqlite')), /Faz 1/);
  const source = path.join(dir, 'demo.sqlite');
  const store = createStore(source);
  store.close();
  const target = path.join(dir, 'target.sqlite');
  fs.writeFileSync(`${target}-wal`, 'untouched');
  assert.throws(() => snapshot(source, target), /zaten var/);
  assert.equal(fs.readFileSync(`${target}-wal`, 'utf8'), 'untouched');
});
