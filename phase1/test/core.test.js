'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStore, DomainError } = require('../core');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencreditic-phase1-'));
  const store = createStore(path.join(dir, 'demo.sqlite'));
  return { dir, store };
}

test('topup and payment are idempotent and use a single pulse command', () => {
  const { store } = freshStore();
  try {
    const topup = store.topUp({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountCents: 20_000, idempotencyKey: 'topup-critical-001' });
    assert.equal(topup.balanceAfterCents, 20_000);
    const payment = store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'payment-critical-001' });
    assert.equal(payment.approved, true);
    assert.equal(payment.balanceAfterCents, 17_500);
    const duplicate = store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'payment-critical-001' });
    assert.equal(duplicate.duplicate, true);
    assert.equal(store.summary().ledger_count, 2);
    assert.equal(store.summary().pulseCount, 1);
  } finally { store.close(); }
});

test('two same-balance payment attempts cannot both pass', () => {
  const { store } = freshStore();
  try {
    store.topUp({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountCents: 2_500, idempotencyKey: 'topup-race-001' });
    const first = store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'payment-race-001' });
    const second = store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'payment-race-002' });
    assert.equal(first.approved, true);
    assert.equal(second.approved, false);
    assert.equal(second.reason, 'insufficient_balance');
    assert.equal(store.getAccount('demo-account').tl_balance_cents, 0);
  } finally { store.close(); }
});

test('demo free play count is separate from paid charge and topup totals', () => {
  const { store } = freshStore();
  try {
    store.topUp({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountCents: 10000, idempotencyKey: 'free-mixed-topup-001' });
    store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'free-mixed-paid-001' });
    store.setDemoState({ cardUid: 'DEMO-0001', present: true }, 'DEMO-MACHINE');
    store.demoFreePlay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', reason: 'Demo ücretsiz test oyunu', idempotencyKey: 'free-mixed-play-001', actorUserId: null });
    assert.equal(store.getAccount('demo-account').tl_balance_cents, 7500);
    const report = store.periodReport('day');
    assert.equal(report.totals.topups_cents, 10000);
    assert.equal(report.totals.game_charges_cents, 2500);
    assert.equal(report.totals.free_plays_count, 1);
    assert.equal(store.summary().pulseCount, 2);
  } finally { store.close(); }
});

test('pulse retry keeps the original command and payment record', () => {
  const { store } = freshStore();
  try {
    store.topUp({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountCents: 2_500, idempotencyKey: 'topup-pulse-001' });
    const payment = store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'payment-pulse-001' });
    const ambiguous = store.simulatePulse(payment.pulseCommandId, 'response_lost');
    assert.equal(ambiguous.status, 'ambiguous');
    const { DatabaseSync } = require('node:sqlite');
    const inspection = new DatabaseSync(store.dbPath);
    assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'pulse.review_required'").get().count, 1);
    inspection.close();
    assert.throws(() => store.retryPulse(payment.pulseCommandId), /inceleme/);
    assert.equal(store.getPulseCommand(payment.pulseCommandId).status, 'ambiguous');
    assert.equal(store.summary().pulseCount, 1);
    const secondAttempt = store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'payment-pulse-001-different' });
    assert.equal(secondAttempt.approved, false);
    assert.equal(secondAttempt.reason, 'insufficient_balance');
  } finally { store.close(); }
});

test('pulse validation and card UID normalization keep hardware assumptions explicit', () => {
  const { store } = freshStore();
  try {
    assert.throws(() => store.updateMachine('DEMO-MACHINE', { pulseMs: 9 }, null), /pulse_ms/);
    assert.equal(store.getCard('  demo-0001 ').uid, 'DEMO-0001');
    assert.throws(() => store.getCard('1234/unsafe'), /Kart numarası/);
  } finally { store.close(); }
});

test('payment snapshots the machine settings and survives a reopen', () => {
  const { dir, store } = freshStore();
  const databasePath = path.join(dir, 'demo.sqlite');
  try {
    store.topUp({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountCents: 5_000, idempotencyKey: 'topup-snapshot-001' });
    const payment = store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'payment-snapshot-001' });
    store.updateMachine('DEMO-MACHINE', { priceCents: 3_000 }, null);
    assert.equal(store.getPulseCommand(payment.pulseCommandId).amount_cents, 2_500);
  } finally { store.close(); }
  const reopened = createStore(databasePath);
  try {
    assert.equal(reopened.getAccount('demo-account').tl_balance_cents, 2_500);
    assert.equal(reopened.summary().ledger_count, 2);
  } finally { reopened.close(); }
});

test('period reports separate topups, spending and current balance in Istanbul calendar periods', () => {
  const { store } = freshStore();
  const { DatabaseSync } = require('node:sqlite');
  try {
    store.createMachine({ id: 'SECOND', name: 'İkinci cihaz', priceCents: 5000 });
    store.topUp({ accountId: 'demo-account', amountCents: 20000, idempotencyKey: 'report-topup-001' });
    store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'report-payment-001' });
    store.pay({ machineId: 'SECOND', cardUid: 'DEMO-0001', idempotencyKey: 'report-payment-002' });
    store.pay({ machineId: 'SECOND', cardUid: 'DEMO-0001', idempotencyKey: 'report-payment-002' });
    store.correctBalance({ accountId: 'demo-account', amountCents: 1000, reason: 'Test demo correction', idempotencyKey: 'report-correction-001', actorUserId: null });
    const db = new DatabaseSync(store.dbPath);
    const time = db.prepare('UPDATE ledger_entries SET created_at = ? WHERE idempotency_key = ?');
    time.run('2026-01-04T20:59:59.000Z', 'report-topup-001:ledger');
    time.run('2026-01-04T21:00:00.000Z', 'report-payment-001:ledger');
    time.run('2026-01-05T08:00:00.000Z', 'report-payment-002:ledger');
    time.run('2026-01-05T08:00:00.000Z', 'report-correction-001:ledger');
    db.close();
    const now = new Date('2026-01-05T12:00:00.000Z'); // Monday in Istanbul
    const day = store.periodReport('day', now);
    assert.equal(day.start, '2026-01-05 00:00:00');
    assert.equal(day.totals.topups_cents, 0);
    assert.equal(day.totals.game_charges_cents, 7500);
    assert.equal(day.totals.corrections_cents, 1000);
    assert.equal(day.balance_cents, 13500);
    assert.equal(day.buckets.length, 24);
    assert.equal(day.buckets[0].cents, 2500);
    assert.deepEqual(day.machines.map(item => [item.machine_id, item.cents]), [['SECOND', 5000], ['DEMO-MACHINE', 2500]]);
    const week = store.periodReport('week', now);
    assert.equal(week.start, '2026-01-05 00:00:00');
    assert.equal(week.buckets.length, 7);
    const month = store.periodReport('month', now);
    assert.equal(month.totals.topups_cents, 20000);
    assert.equal(month.totals.game_charges_cents, 7500);
    assert.equal(month.buckets.length, 31);
    assert.equal(store.periodReport('year', now).buckets.length, 12);
    assert.equal(store.periodReport('day', new Date('2026-01-04T21:00:00.000Z')).totals.game_charges_cents, 2500);
    assert.throws(() => store.periodReport('invalid'), /dönemi/);
  } finally { store.close(); }
});

test('historical reports use Istanbul DST boundaries and expose ambiguous commands separately', () => {
  const { store } = freshStore();
  const { DatabaseSync } = require('node:sqlite');
  try {
    store.topUp({ accountId: 'demo-account', amountCents: 20000, idempotencyKey: 'historic-topup-001' });
    const payments = [];
    for (let i = 0; i < 4; i++) payments.push(store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: `historic-pay-00${i}` }));
    store.simulatePulse(payments[1].pulseCommandId, 'response_lost');
    store.simulatePulse(payments[2].pulseCommandId, 'succeeded');
    store.simulatePulse(payments[3].pulseCommandId, 'failed');
    const db = new DatabaseSync(store.dbPath);
    const update = db.prepare('UPDATE ledger_entries SET created_at = ? WHERE idempotency_key = ?');
    ['2016-03-26T21:59:59.000Z', '2016-03-26T22:00:00.000Z', '2016-03-27T20:59:59.000Z', '2016-03-27T21:00:00.000Z'].forEach((date, i) => update.run(date, `historic-pay-00${i}:ledger`));
    db.close();
    const now = new Date('2026-11-06T12:00:00.000Z');
    const day = store.periodReport('day', now, '2016-03-27');
    assert.equal(day.start, '2016-03-27 00:00:00');
    assert.equal(day.end, '2016-03-28 00:00:00');
    assert.equal(day.totals.game_charges_cents, 5000);
    assert.equal(day.commandStatus.ambiguous, 2500);
    assert.equal(day.commandStatus.succeeded, 2500);
    assert.equal(day.commandStatus.failed, 0);
    assert.equal(day.buckets[0].cents, 2500);
    assert.equal(day.buckets[23].cents, 2500);
    assert.equal(store.periodReport('week', now, '2016-03-27').start, '2016-03-21 00:00:00');
    assert.equal(store.periodReport('month', now, '2016-03-27').totals.game_charges_cents, 10000);
    assert.equal(store.periodReport('year', now, '2016-03-27').totals.game_charges_cents, 10000);
    assert.equal(store.periodReport('day', now, '2016-03-28').commandStatus.failed, 2500);
    assert.throws(() => store.periodReport('day', now, '2026-02-30'), /tarih/);
    assert.equal(store.periodReport('week', now, '2026-01-01').start, '2025-12-29 00:00:00');
    const db2 = new DatabaseSync(store.dbPath);
    const update2 = db2.prepare('UPDATE ledger_entries SET created_at = ? WHERE idempotency_key = ?');
    update2.run('2015-11-08T00:30:00.000Z', 'historic-pay-001:ledger');
    update2.run('2015-11-08T01:30:00.000Z', 'historic-pay-002:ledger');
    db2.close();
    const repeated = store.periodReport('day', now, '2015-11-08');
    assert.equal(repeated.buckets[3].cents, 5000);
    assert.equal(repeated.commandStatus.ambiguous, 2500);
  } finally { store.close(); }
});
