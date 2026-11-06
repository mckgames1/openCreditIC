'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class DomainError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isoNow() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function requestHash(operation, payload) {
  return crypto.createHash('sha256').update(`${operation}:${stableStringify(payload)}`).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const [, salt, expected] = String(encoded || '').split('$');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizeUid(value) {
  const uid = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9:_-]{1,128}$/.test(uid)) {
    throw new DomainError('invalid_card_uid', 'Kart UID biçimi geçersiz. Baştaki sıfırlar korunur.');
  }
  return uid;
}

function positiveInteger(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new DomainError('invalid_value', `${field} geçerli bir tam sayı olmalıdır.`);
  }
  return number;
}

function nonNegativeInteger(value, field, { max = Number.MAX_SAFE_INTEGER } = {}) {
  return positiveInteger(value, field, { min: 0, max });
}

function parseMoneyCents(value, field = 'tutar') {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new DomainError('invalid_amount', `${field} en fazla iki ondalık basamaklı pozitif bir tutar olmalıdır.`);
  }
  const [lira, kurus = ''] = text.split('.');
  const cents = Number(lira) * 100 + Number((kurus + '00').slice(0, 2));
  return positiveInteger(cents, field, { max: 9_000_000_000_000_000 });
}

function formatMoney(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function createStore(databasePath) {
  const resolvedPath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  seedDemoData(db);

  function withImmediateTransaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* preserve original error */ }
      throw error;
    }
  }

  function one(sql, params = {}) {
    return db.prepare(sql).get(params);
  }

  function many(sql, params = {}) {
    return db.prepare(sql).all(params);
  }

  function run(sql, params = {}) {
    return db.prepare(sql).run(params);
  }

  function audit(eventType, actorUserId, data) {
    run('INSERT INTO audit_log (id, event_type, actor_user_id, data_json, created_at) VALUES ($id, $eventType, $actorUserId, $dataJson, $createdAt)', {
      $id: makeId('aud'), $eventType: eventType, $actorUserId: actorUserId,
      $dataJson: JSON.stringify(data || {}), $createdAt: isoNow()
    });
  }

  function ensureIdempotency(key, operation, payload) {
    const normalizedKey = String(key || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(normalizedKey)) {
      throw new DomainError('invalid_idempotency_key', 'İşlem anahtarı 8–200 karakter olmalı ve yalnızca güvenli karakterler içermelidir.');
    }
    const hash = requestHash(operation, payload);
    const existing = one('SELECT * FROM idempotency_keys WHERE idempotency_key = $key', { $key: normalizedKey });
    if (!existing) return { key: normalizedKey, hash, duplicate: false };
    if (existing.request_hash !== hash || existing.operation !== operation) {
      throw new DomainError('idempotency_conflict', 'Aynı işlem anahtarı farklı içerikle kullanılamaz.', 409);
    }
    return { key: normalizedKey, hash, duplicate: true, response: JSON.parse(existing.response_json) };
  }

  function saveIdempotency(key, operation, hash, response) {
    run(`INSERT INTO idempotency_keys (idempotency_key, operation, request_hash, response_json, created_at)
         VALUES ($key, $operation, $hash, $response, $createdAt)`, {
      $key: key, $operation: operation, $hash: hash,
      $response: JSON.stringify(response), $createdAt: isoNow()
    });
  }

  function getConfig() {
    const rows = many('SELECT key, value FROM settings ORDER BY key');
    const config = {};
    for (const row of rows) {
      config[row.key] = /^\d+$/.test(row.value) ? Number(row.value) : row.value === 'true' ? true : row.value === 'false' ? false : row.value;
    }
    return config;
  }

  function setConfig(values, actorUserId = null) {
    return withImmediateTransaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (!['card_removed_ms', 'payment_cooldown_ms'].includes(key)) {
          throw new DomainError('invalid_setting', `Ayar değiştirilemez: ${key}`);
        }
        const number = nonNegativeInteger(value, key, { max: 60_000 });
        run('INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', {
          $key: key, $value: String(number)
        });
      }
      audit('settings.updated', actorUserId, values);
      return getConfig();
    });
  }

  function createUser({ username, password, role = 'staff' }) {
    const normalizedUsername = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(normalizedUsername)) {
      throw new DomainError('invalid_username', 'Kullanıcı adı 3–64 karakter olmalı ve yalnızca a-z, 0-9, nokta, alt çizgi veya tire içermelidir.');
    }
    if (String(password || '').length < 10) {
      throw new DomainError('weak_password', 'Parola en az 10 karakter olmalıdır.');
    }
    if (!['admin', 'staff'].includes(role)) throw new DomainError('invalid_role', 'Geçersiz rol.');
    const id = makeId('usr');
    try {
      run(`INSERT INTO users (id, username, password_hash, role, created_at)
           VALUES ($id, $username, $passwordHash, $role, $createdAt)`, {
        $id: id, $username: normalizedUsername, $passwordHash: hashPassword(password), $role: role, $createdAt: isoNow()
      });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new DomainError('username_exists', 'Bu kullanıcı adı zaten kayıtlı.', 409);
      throw error;
    }
    return publicUser(one('SELECT * FROM users WHERE id = $id', { $id: id }));
  }

  function authenticate(username, password) {
    const user = one('SELECT * FROM users WHERE username = $username', { $username: String(username || '').trim().toLowerCase() });
    if (!user || user.locked || !verifyPassword(String(password || ''), user.password_hash)) {
      throw new DomainError('invalid_credentials', 'Kullanıcı adı veya parola hatalı.', 401);
    }
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    run('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ($token, $userId, $expiresAt, $createdAt)', {
      $token: token, $userId: user.id, $expiresAt: expiresAt, $createdAt: isoNow()
    });
    return { token, user: publicUser(user), expiresAt };
  }

  function sessionUser(token) {
    if (!token) return null;
    const row = one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                    WHERE s.token = $token AND s.expires_at > $now`, { $token: token, $now: isoNow() });
    return row ? publicUser(row) : null;
  }

  function revokeSession(token) {
    if (token) run('DELETE FROM sessions WHERE token = $token', { $token: token });
  }

  function createAccount({ name, actorUserId = null }) {
    const normalizedName = String(name || '').trim();
    if (normalizedName.length < 2 || normalizedName.length > 120) throw new DomainError('invalid_account_name', 'Hesap adı 2–120 karakter olmalıdır.');
    const id = makeId('acct');
    run('INSERT INTO accounts (id, name, created_at) VALUES ($id, $name, $createdAt)', { $id: id, $name: normalizedName, $createdAt: isoNow() });
    audit('account.created', actorUserId, { accountId: id });
    return getAccount(id);
  }

  function getAccount(id) {
    const account = one('SELECT * FROM accounts WHERE id = $id', { $id: id });
    if (!account) throw new DomainError('account_not_found', 'Hesap bulunamadı.', 404);
    return account;
  }

  function createCard({ uid, accountId, actorUserId = null }) {
    const normalizedUid = normalizeUid(uid);
    getAccount(accountId);
    try {
      run(`INSERT INTO cards (uid, account_id, locked, created_at) VALUES ($uid, $accountId, 0, $createdAt)`, {
        $uid: normalizedUid, $accountId: accountId, $createdAt: isoNow()
      });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new DomainError('card_exists', 'Bu kart zaten kayıtlı.', 409);
      throw error;
    }
    audit('card.created', actorUserId, { uid: normalizedUid, accountId });
    return getCard(normalizedUid);
  }

  function getCard(uid) {
    const card = one(`SELECT c.*, a.name AS account_name, a.tl_balance_cents, a.ticket_balance, a.locked AS account_locked
                      FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.uid = $uid`, { $uid: normalizeUid(uid) });
    if (!card) throw new DomainError('card_not_found', 'Kart bulunamadı.', 404);
    return card;
  }

  function createDemoAccountCard({ name, uid, idempotencyKey, actorUserId }) {
    const payload = { name: String(name || '').trim(), uid: normalizeUid(uid) };
    return withImmediateTransaction(() => {
      const key = ensureIdempotency(idempotencyKey, 'demo_registration', payload);
      if (key.duplicate) return { ...key.response, duplicate: true };
      const account = createAccount({ name: payload.name, actorUserId });
      const card = createCard({ uid: payload.uid, accountId: account.id, actorUserId });
      const response = { ok: true, account, card };
      saveIdempotency(key.key, 'demo_registration', key.hash, response);
      return response;
    });
  }

  function setCardLock(uid, locked, actorUserId) {
    const card = getCard(uid);
    run('UPDATE cards SET locked = $locked, updated_at = $updatedAt WHERE uid = $uid', { $uid: card.uid, $locked: locked ? 1 : 0, $updatedAt: isoNow() });
    audit(locked ? 'card.locked' : 'card.unlocked', actorUserId, { uid: card.uid });
    return getCard(card.uid);
  }

  function createMachine({ id, name, priceCents = 2500, pulseMs = 100, pulseCount = 1, pulseGapMs = 100, actorUserId = null }) {
    const normalizedId = String(id || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,64}$/.test(normalizedId)) throw new DomainError('invalid_machine_id', 'Makine kimliği geçersiz.');
    const machineName = String(name || '').trim();
    if (!machineName) throw new DomainError('invalid_machine_name', 'Makine adı boş olamaz.');
    validatePulse(pulseMs, pulseCount, pulseGapMs);
    priceCents = positiveInteger(priceCents, 'fiyat', { max: 9_000_000_000_000_000 });
    try {
      run(`INSERT INTO machines (id, name, price_cents, pulse_ms, pulse_count, pulse_gap_ms, enabled, settings_version, created_at)
           VALUES ($id, $name, $priceCents, $pulseMs, $pulseCount, $pulseGapMs, 1, 1, $createdAt)`, {
        $id: normalizedId, $name: machineName, $priceCents: priceCents, $pulseMs: pulseMs,
        $pulseCount: pulseCount, $pulseGapMs: pulseGapMs, $createdAt: isoNow()
      });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new DomainError('machine_exists', 'Bu makine zaten kayıtlı.', 409);
      throw error;
    }
    audit('machine.created', actorUserId, { machineId: normalizedId });
    return getMachine(normalizedId);
  }

  function getMachine(id) {
    const machine = one('SELECT * FROM machines WHERE id = $id', { $id: String(id || '').trim().toUpperCase() });
    if (!machine) throw new DomainError('machine_not_found', 'Makine bulunamadı.', 404);
    return machine;
  }

  function updateMachine(id, changes, actorUserId) {
    const machine = getMachine(id);
    const next = {
      name: changes.name === undefined ? machine.name : String(changes.name).trim(),
      priceCents: changes.priceCents === undefined ? machine.price_cents : positiveInteger(changes.priceCents, 'fiyat', { max: 9_000_000_000_000_000 }),
      pulseMs: changes.pulseMs === undefined ? machine.pulse_ms : nonNegativeInteger(changes.pulseMs, 'pulse_ms', { max: 1000 }),
      pulseCount: changes.pulseCount === undefined ? machine.pulse_count : positiveInteger(changes.pulseCount, 'pulse_count', { max: 100 }),
      pulseGapMs: changes.pulseGapMs === undefined ? machine.pulse_gap_ms : nonNegativeInteger(changes.pulseGapMs, 'pulse_gap_ms', { max: 10_000 }),
      enabled: changes.enabled === undefined ? Boolean(machine.enabled) : Boolean(changes.enabled)
    };
    if (!next.name) throw new DomainError('invalid_machine_name', 'Makine adı boş olamaz.');
    validatePulse(next.pulseMs, next.pulseCount, next.pulseGapMs);
    run(`UPDATE machines SET name = $name, price_cents = $priceCents, pulse_ms = $pulseMs, pulse_count = $pulseCount,
         pulse_gap_ms = $pulseGapMs, enabled = $enabled, settings_version = settings_version + 1, updated_at = $updatedAt WHERE id = $id`, {
      $id: machine.id, $name: next.name, $priceCents: next.priceCents, $pulseMs: next.pulseMs,
      $pulseCount: next.pulseCount, $pulseGapMs: next.pulseGapMs, $enabled: next.enabled ? 1 : 0, $updatedAt: isoNow()
    });
    audit('machine.updated', actorUserId, { machineId: machine.id, settingsVersion: machine.settings_version + 1 });
    return getMachine(machine.id);
  }

  function topUp({ accountId, cardUid = null, amountCents, idempotencyKey, actorUserId = null, entryType = 'topup', note = null }) {
    amountCents = positiveInteger(amountCents, 'yükleme tutarı', { max: 9_000_000_000_000_000 });
    const payload = { accountId, cardUid: cardUid ? normalizeUid(cardUid) : null, amountCents, entryType, note: note || null };
    return withImmediateTransaction(() => {
      const idempotency = ensureIdempotency(idempotencyKey, 'topup', payload);
      if (idempotency.duplicate) return { ...idempotency.response, duplicate: true };
      const account = getAccount(accountId);
      if (account.locked) throw new DomainError('account_locked', 'Hesap kilitli.', 403);
      if (payload.cardUid) {
        const card = getCard(payload.cardUid);
        if (card.account_id !== accountId) throw new DomainError('card_account_mismatch', 'Kart bu hesaba bağlı değil.');
        if (card.locked) throw new DomainError('card_locked', 'Kart kilitli.', 403);
      }
      const balanceAfterCents = account.tl_balance_cents + amountCents;
      const entryId = makeId('led');
      run(`INSERT INTO ledger_entries (id, account_id, card_uid, actor_user_id, entry_type, amount_cents, ticket_delta,
           balance_after_cents, idempotency_key, note, created_at)
           VALUES ($id, $accountId, $cardUid, $actorUserId, $entryType, $amountCents, 0, $balanceAfterCents, $idempotencyKey, $note, $createdAt)`, {
        $id: entryId, $accountId: accountId, $cardUid: payload.cardUid, $actorUserId: actorUserId, $entryType: entryType,
        $amountCents: amountCents, $balanceAfterCents: balanceAfterCents, $idempotencyKey: `${idempotency.key}:ledger`, $note: note, $createdAt: isoNow()
      });
      run('UPDATE accounts SET tl_balance_cents = $balanceAfterCents, updated_at = $updatedAt WHERE id = $accountId', {
        $balanceAfterCents: balanceAfterCents, $updatedAt: isoNow(), $accountId: accountId
      });
      const response = { ok: true, entryId, accountId, amountCents, balanceAfterCents, entryType };
      saveIdempotency(idempotency.key, 'topup', idempotency.hash, response);
      audit('balance.credited', actorUserId, { accountId, amountCents, entryType, entryId });
      return response;
    });
  }

  function pay({ machineId, cardUid, idempotencyKey, actorUserId = null }) {
    const payload = { machineId: String(machineId || '').trim().toUpperCase(), cardUid: normalizeUid(cardUid) };
    return withImmediateTransaction(() => {
      const idempotency = ensureIdempotency(idempotencyKey, 'payment', payload);
      if (idempotency.duplicate) return { ...idempotency.response, duplicate: true };
      const machine = getMachine(payload.machineId);
      const card = getCard(payload.cardUid);
      if (!machine.enabled) throw new DomainError('machine_disabled', 'Makine pasif.', 409);
      if (card.locked || card.account_locked) throw new DomainError('card_locked', 'Kart veya hesap kilitli.', 403);
      const priceCents = machine.price_cents;
      if (card.tl_balance_cents < priceCents) {
        const response = { ok: false, approved: false, reason: 'insufficient_balance', balanceAfterCents: card.tl_balance_cents, priceCents };
        saveIdempotency(idempotency.key, 'payment', idempotency.hash, response);
        return response;
      }
      const balanceAfterCents = card.tl_balance_cents - priceCents;
      const pulseCommandId = makeId('pulse');
      run(`INSERT INTO ledger_entries (id, account_id, card_uid, actor_user_id, entry_type, amount_cents, ticket_delta,
           balance_after_cents, idempotency_key, note, created_at)
           VALUES ($id, $accountId, $cardUid, $actorUserId, 'game_charge', $amountCents, 0, $balanceAfterCents, $idempotencyKey, $note, $createdAt)`, {
        $id: makeId('led'), $accountId: card.account_id, $cardUid: card.uid, $actorUserId: actorUserId,
        $amountCents: -priceCents, $balanceAfterCents: balanceAfterCents, $idempotencyKey: `${idempotency.key}:ledger`,
        $note: 'Faz 1 demo ödeme', $createdAt: isoNow()
      });
      run('UPDATE accounts SET tl_balance_cents = $balanceAfterCents, updated_at = $updatedAt WHERE id = $accountId', {
        $balanceAfterCents: balanceAfterCents, $updatedAt: isoNow(), $accountId: card.account_id
      });
      run(`INSERT INTO pulse_commands (id, machine_id, account_id, card_uid, actor_user_id, amount_cents,
           pulse_ms, pulse_count, pulse_gap_ms, status, attempt_count, idempotency_key, created_at, updated_at)
           VALUES ($id, $machineId, $accountId, $cardUid, $actorUserId, $amountCents, $pulseMs, $pulseCount, $pulseGapMs,
           'pending', 0, $idempotencyKey, $createdAt, $updatedAt)`, {
        $id: pulseCommandId, $machineId: machine.id, $accountId: card.account_id, $cardUid: card.uid, $actorUserId: actorUserId,
        $amountCents: priceCents, $pulseMs: machine.pulse_ms, $pulseCount: machine.pulse_count, $pulseGapMs: machine.pulse_gap_ms,
        $idempotencyKey: idempotency.key, $createdAt: isoNow(), $updatedAt: isoNow()
      });
      const response = { ok: true, approved: true, balanceAfterCents, priceCents, pulseCommandId, settingsVersion: machine.settings_version };
      saveIdempotency(idempotency.key, 'payment', idempotency.hash, response);
      audit('payment.approved', actorUserId, { accountId: card.account_id, cardUid: card.uid, machineId: machine.id, pulseCommandId });
      return response;
    });
  }

  function getPulseCommand(commandId) {
    const command = one('SELECT * FROM pulse_commands WHERE id = $id', { $id: commandId });
    if (!command) throw new DomainError('pulse_not_found', 'Pulse komutu bulunamadı.', 404);
    return command;
  }

  function getIdempotency(idempotencyKey) {
    const row = one('SELECT operation, response_json, created_at FROM idempotency_keys WHERE idempotency_key = $key', { $key: String(idempotencyKey || '') });
    return row ? { operation: row.operation, response: JSON.parse(row.response_json), createdAt: row.created_at } : null;
  }

  function simulatePulse(commandId, outcome, actorUserId = null) {
    if (!['succeeded', 'response_lost', 'connection_lost', 'failed'].includes(outcome)) {
      throw new DomainError('invalid_pulse_outcome', 'Geçersiz simülasyon sonucu.');
    }
    const command = getPulseCommand(commandId);
    if (command.status === 'succeeded') return command;
    const status = outcome === 'succeeded' ? 'succeeded' : outcome === 'failed' ? 'failed' : 'ambiguous';
    run('UPDATE pulse_commands SET status = $status, last_outcome = $outcome, updated_at = $updatedAt WHERE id = $id', {
      $id: command.id, $status: status, $outcome: outcome, $updatedAt: isoNow()
    });
    audit('pulse.simulated', actorUserId, { commandId, outcome, status });
    return getPulseCommand(commandId);
  }

  function retryPulse(commandId, actorUserId = null) {
    const command = getPulseCommand(commandId);
    if (command.status === 'succeeded') return command;
    run('UPDATE pulse_commands SET status = \'pending\', attempt_count = attempt_count + 1, last_outcome = NULL, updated_at = $updatedAt WHERE id = $id', {
      $id: command.id, $updatedAt: isoNow()
    });
    audit('pulse.retry', actorUserId, { commandId, attempt: command.attempt_count + 1 });
    return getPulseCommand(commandId);
  }

  function listAccounts() {
    return many(`SELECT a.*, COUNT(c.uid) AS card_count FROM accounts a LEFT JOIN cards c ON c.account_id = a.id
                 GROUP BY a.id ORDER BY a.created_at DESC`);
  }

  function listCards() {
    return many(`SELECT c.uid, c.account_id, c.locked, c.created_at, a.name AS account_name, a.tl_balance_cents, a.ticket_balance,
                 a.locked AS account_locked FROM cards c JOIN accounts a ON a.id = c.account_id ORDER BY c.created_at DESC`);
  }

  function listMachines() { return many('SELECT * FROM machines ORDER BY id'); }

  function listLedger({ actorUserId = null, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    if (actorUserId) return many(`SELECT * FROM ledger_entries WHERE actor_user_id = $actorUserId ORDER BY created_at DESC LIMIT ${safeLimit}`, { $actorUserId: actorUserId });
    return many(`SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT ${safeLimit}`);
  }

  function listPulses(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return many(`SELECT * FROM pulse_commands ORDER BY created_at DESC LIMIT ${safeLimit}`);
  }

  function summary() {
    const row = one(`SELECT
      COALESCE(SUM(CASE WHEN entry_type = 'topup' THEN amount_cents ELSE 0 END), 0) AS topups_cents,
      COALESCE(SUM(CASE WHEN entry_type = 'game_charge' THEN -amount_cents ELSE 0 END), 0) AS game_charges_cents,
      COALESCE(SUM(CASE WHEN entry_type = 'bonus' THEN amount_cents ELSE 0 END), 0) AS bonuses_cents,
      COALESCE(SUM(CASE WHEN entry_type = 'free_play' THEN -amount_cents ELSE 0 END), 0) AS free_play_cents,
      COUNT(*) AS ledger_count FROM ledger_entries`);
    return { ...row, accountCount: one('SELECT COUNT(*) AS count FROM accounts').count, cardCount: one('SELECT COUNT(*) AS count FROM cards').count, machineCount: one('SELECT COUNT(*) AS count FROM machines').count, pulseCount: one('SELECT COUNT(*) AS count FROM pulse_commands').count };
  }

  function close() { db.close(); }

  return {
    dbPath: resolvedPath, close, getConfig, setConfig, createUser, authenticate, sessionUser, revokeSession,
    createAccount, createDemoAccountCard, getAccount, listAccounts, createCard, getCard, setCardLock, listCards,
    createMachine, getMachine, updateMachine, listMachines, topUp, pay, getPulseCommand, simulatePulse,
    retryPulse, getIdempotency, listLedger, listPulses, summary, getUserCount: () => one('SELECT COUNT(*) AS count FROM users').count,
    getUsers: () => many('SELECT id, username, role, locked, created_at FROM users ORDER BY created_at'),
    getDemoState: () => one('SELECT * FROM simulator_state WHERE id = 1'),
    setDemoState: (state) => {
      run(`UPDATE simulator_state SET card_uid = $cardUid, present = $present, removed_at_ms = $removedAtMs,
           eligible_at_ms = $eligibleAtMs, payment_latched = $paymentLatched, last_payment_at_ms = $lastPaymentAtMs, updated_at = $updatedAt WHERE id = 1`, {
        $cardUid: state.cardUid || null, $present: state.present ? 1 : 0, $removedAtMs: state.removedAtMs || 0,
        $eligibleAtMs: state.eligibleAtMs || 0, $paymentLatched: state.paymentLatched ? 1 : 0,
        $lastPaymentAtMs: state.lastPaymentAtMs || 0, $updatedAt: isoNow()
      });
      return one('SELECT * FROM simulator_state WHERE id = 1');
    },
    audit: (eventType, actorUserId, data) => audit(eventType, actorUserId, data)
  };
}

function validatePulse(pulseMs, pulseCount, pulseGapMs) {
  positiveInteger(pulseMs, 'pulse_ms', { min: 10, max: 1000 });
  positiveInteger(pulseCount, 'pulse_count', { max: 100 });
  nonNegativeInteger(pulseGapMs, 'pulse_gap_ms', { max: 10_000 });
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, locked: Boolean(user.locked), created_at: user.created_at };
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin', 'staff')), locked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, tl_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK(tl_balance_cents >= 0), ticket_balance INTEGER NOT NULL DEFAULT 0 CHECK(ticket_balance >= 0), locked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS cards (uid TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), locked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents > 0), pulse_ms INTEGER NOT NULL CHECK(pulse_ms BETWEEN 10 AND 1000), pulse_count INTEGER NOT NULL CHECK(pulse_count > 0), pulse_gap_ms INTEGER NOT NULL CHECK(pulse_gap_ms >= 0), enabled INTEGER NOT NULL DEFAULT 1, settings_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS idempotency_keys (idempotency_key TEXT PRIMARY KEY, operation TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_entries (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), card_uid TEXT, actor_user_id TEXT REFERENCES users(id), entry_type TEXT NOT NULL CHECK(entry_type IN ('topup', 'game_charge', 'refund', 'bonus', 'free_play', 'correction')), amount_cents INTEGER NOT NULL, ticket_delta INTEGER NOT NULL DEFAULT 0, balance_after_cents INTEGER NOT NULL CHECK(balance_after_cents >= 0), idempotency_key TEXT NOT NULL UNIQUE, note TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pulse_commands (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id), account_id TEXT NOT NULL REFERENCES accounts(id), card_uid TEXT NOT NULL, actor_user_id TEXT REFERENCES users(id), amount_cents INTEGER NOT NULL, pulse_ms INTEGER NOT NULL, pulse_count INTEGER NOT NULL, pulse_gap_ms INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'ambiguous', 'failed')), attempt_count INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, actor_user_id TEXT REFERENCES users(id), data_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS simulator_state (id INTEGER PRIMARY KEY CHECK(id = 1), card_uid TEXT, present INTEGER NOT NULL DEFAULT 0, removed_at_ms INTEGER NOT NULL DEFAULT 0, eligible_at_ms INTEGER NOT NULL DEFAULT 0, payment_latched INTEGER NOT NULL DEFAULT 0, last_payment_at_ms INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_ledger_created_at ON ledger_entries(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);`);
  const migration = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get();
  if (!migration) {
    const now = isoNow();
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, $now)').run({ $now: now });
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (\'card_removed_ms\', \'1000\'), (\'payment_cooldown_ms\', \'500\'), (\'demo_mode\', \'true\')').run();
    db.prepare('INSERT OR IGNORE INTO simulator_state (id, updated_at) VALUES (1, $now)').run({ $now: now });
  }
}

function seedDemoData(db) {
  const account = db.prepare('SELECT id FROM accounts WHERE id = \'demo-account\'').get();
  if (!account) {
    const now = isoNow();
    db.prepare('INSERT INTO accounts (id, name, created_at, updated_at) VALUES (\'demo-account\', \'Demo Hesap\', $now, $now)').run({ $now: now });
    db.prepare('INSERT INTO cards (uid, account_id, created_at, updated_at) VALUES (\'DEMO-0001\', \'demo-account\', $now, $now)').run({ $now: now });
  }
  const machine = db.prepare('SELECT id FROM machines WHERE id = \'DEMO-MACHINE\'').get();
  if (!machine) {
    const now = isoNow();
    db.prepare(`INSERT INTO machines (id, name, price_cents, pulse_ms, pulse_count, pulse_gap_ms, enabled, settings_version, created_at, updated_at)
                VALUES ('DEMO-MACHINE', 'Demo Makine', 2500, 100, 1, 100, 1, 1, $now, $now)`).run({ $now: now });
  }
}

module.exports = { createStore, DomainError, parseMoneyCents, formatMoney, normalizeUid };
