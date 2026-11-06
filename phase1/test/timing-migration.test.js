'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../core');

test('v2 demo data is backed up before copying timing settings to each device', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-v2-'));
  const file = path.join(dir, 'legacy-demo.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(1,'old'),(2,'old');
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES('card_removed_ms','2345'),('payment_cooldown_ms','4567'),('demo_mode','true');
    CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,tl_balance_cents INTEGER NOT NULL DEFAULT 0,ticket_balance INTEGER NOT NULL DEFAULT 0,locked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT '');
    INSERT INTO accounts VALUES('demo-account','Existing',12345,0,0,'old','old');
    CREATE TABLE cards(uid TEXT PRIMARY KEY,account_id TEXT NOT NULL,locked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT '');
    INSERT INTO cards VALUES('DEMO-0001','demo-account',0,'old','old');
    CREATE TABLE machines(id TEXT PRIMARY KEY,name TEXT NOT NULL,price_cents INTEGER NOT NULL,pulse_ms INTEGER NOT NULL,pulse_count INTEGER NOT NULL,pulse_gap_ms INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,settings_version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT '');
    INSERT INTO machines VALUES('DEMO-MACHINE','A',2500,100,1,100,1,5,'old','old'),('DEVICE-B','B',2500,100,1,100,1,7,'old','old');
    CREATE TABLE ledger_entries(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,card_uid TEXT,actor_user_id TEXT,entry_type TEXT NOT NULL,amount_cents INTEGER NOT NULL,ticket_delta INTEGER NOT NULL DEFAULT 0,balance_after_cents INTEGER NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,note TEXT,created_at TEXT NOT NULL);
    CREATE TABLE pulse_commands(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,account_id TEXT NOT NULL,card_uid TEXT NOT NULL,actor_user_id TEXT,amount_cents INTEGER NOT NULL,pulse_ms INTEGER NOT NULL,pulse_count INTEGER NOT NULL,pulse_gap_ms INTEGER NOT NULL,status TEXT NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,last_outcome TEXT,idempotency_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE simulator_state(id INTEGER PRIMARY KEY,card_uid TEXT,present INTEGER NOT NULL DEFAULT 0,removed_at_ms INTEGER NOT NULL DEFAULT 0,eligible_at_ms INTEGER NOT NULL DEFAULT 0,payment_latched INTEGER NOT NULL DEFAULT 0,last_payment_at_ms INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
    INSERT INTO simulator_state VALUES(1,'DEMO-0001',1,0,0,1,123456,'old');`);
  db.close();
  const migrated = createStore(file);
  try {
    assert.equal(migrated.getAccount('demo-account').tl_balance_cents, 12345);
    assert.equal(migrated.getMachine('DEMO-MACHINE').card_removed_ms, 2345);
    assert.equal(migrated.getMachine('DEVICE-B').payment_cooldown_ms, 4567);
    assert.equal(migrated.getMachine('DEVICE-B').settings_version, 7);
    assert.equal(migrated.getDemoState().payment_latched, 1);
    assert.equal(migrated.getDemoState().cooldown_until_ms, 123456 + 4567);
  } finally { migrated.close(); }
  const backups = fs.readdirSync(dir).filter(name => name.startsWith('legacy-demo.sqlite.before-v3-') && name.endsWith('.sqlite'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(dir, backups[0]), { readOnly: true });
  assert.equal(backup.prepare('SELECT tl_balance_cents FROM accounts WHERE id = ?').get('demo-account').tl_balance_cents, 12345);
  assert.equal(backup.prepare('SELECT value FROM settings WHERE key = ?').get('card_removed_ms').value, '2345');
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 3').get().n, 0);
  backup.close();
});
