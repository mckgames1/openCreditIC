'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../public/pending-topup.js'), 'utf8');
function storage() {
  const map = new Map();
  return { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, getItem: k => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}
function helper(local, session) {
  const scope = { window: {}, localStorage: local, sessionStorage: session };
  vm.runInNewContext(source, scope);
  return scope.window.PendingDemoTopups;
}
const pending = { userId: 'user-one', body: { accountId: 'demo-account', cardUid: 'DEMO-0001', amountTl: '20', idempotencyKey: 'topup-test-001' } };

test('pending demo topup survives a new browser session and preserves legacy pending records', () => {
  const local = storage(); const oldSession = storage();
  oldSession.setItem('opencreditPendingHomeTopup', JSON.stringify(pending));
  const old = helper(local, oldSession);
  assert.equal(old.list()[0].body.idempotencyKey, pending.body.idempotencyKey);
  assert.notEqual(oldSession.getItem('opencreditPendingHomeTopup'), null);
  const reopened = helper(local, storage());
  assert.equal(reopened.list()[0].userId, 'user-one');
  assert.equal(reopened.list()[0].body.amountTl, '20');
  reopened.clear(reopened.list()[0]);
  assert.equal(reopened.list().length, 0);
});

test('pending demo topups fail closed on conflicting or unavailable storage', () => {
  const local = storage(); const session = storage(); const h = helper(local, session);
  h.save(pending);
  assert.throws(() => h.save({ ...pending, body: { ...pending.body, amountTl: '99' } }), /çakışıyor/);
  assert.equal(h.list()[0].body.amountTl, '20');
  assert.equal(h.validAmount('0'), false);
  assert.equal(h.validAmount('1,234'), false);
  assert.equal(h.validAmount('1,25'), true);
  const blocked = storage(); blocked.setItem = () => { throw new Error('storage blocked'); };
  assert.throws(() => helper(blocked, storage()).save(pending), /storage blocked/);
  local.setItem('opencredit.pending.topup.v1.corrupt', 'not-json');
  assert.throws(() => h.list());
});
