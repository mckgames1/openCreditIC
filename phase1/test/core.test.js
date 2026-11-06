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

test('pulse retry keeps the original command and payment record', () => {
  const { store } = freshStore();
  try {
    store.topUp({ accountId: 'demo-account', cardUid: 'DEMO-0001', amountCents: 2_500, idempotencyKey: 'topup-pulse-001' });
    const payment = store.pay({ machineId: 'DEMO-MACHINE', cardUid: 'DEMO-0001', idempotencyKey: 'payment-pulse-001' });
    const ambiguous = store.simulatePulse(payment.pulseCommandId, 'response_lost');
    assert.equal(ambiguous.status, 'ambiguous');
    const retried = store.retryPulse(payment.pulseCommandId);
    assert.equal(retried.id, payment.pulseCommandId);
    assert.equal(retried.attempt_count, 1);
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
    assert.throws(() => store.getCard('1234/unsafe'), /UID/);
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
