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

function istanbulDayBounds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DomainError('invalid_date', 'Tarih YYYY-AA-GG biçiminde olmalıdır.');
  const [year, month, day] = value.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 9998 || start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) throw new DomainError('invalid_date', 'Geçerli bir tarih seçin (1900–9998).');
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const convert = civil => {
    const target = civil.getTime();
    let instant = target;
    for (let i = 0; i < 5; i++) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(instant)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
      const actual = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      const next = instant + target - actual;
      if (next === instant) return new Date(instant).toISOString();
      instant = next;
    }
    throw new DomainError('invalid_date', 'Bu tarihin yerel saat sınırı belirlenemedi.');
  };
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
  return { start: convert(start), end: convert(end) };
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
    throw new DomainError('invalid_card_uid', 'Kart numarası geçersiz. Harf, rakam, iki nokta, alt çizgi veya tire kullanın. Baştaki sıfırlar korunur.');
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

function createStore(databasePath, options = {}) {
  const resolvedPath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  // Back up existing databases before schema changes.
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).size > 0) {
    const probe = new DatabaseSync(resolvedPath, { readOnly: true });
    let backupVersion;
    try {
      probe.exec('PRAGMA busy_timeout = 5000');
      if (!probe.prepare('SELECT version FROM schema_migrations WHERE version = 3').get()) backupVersion = 3;
      else if (!probe.prepare('SELECT version FROM schema_migrations WHERE version = 4').get()) backupVersion = 4;
    } finally { probe.close(); }
    if (backupVersion) {
      const { snapshot } = require('./scripts/snapshot');
      snapshot(resolvedPath, `${resolvedPath}.before-v${backupVersion}-${crypto.randomUUID()}.sqlite`);
    }
  }
  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
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
    let response;
    try { response = JSON.parse(existing.response_json); }
    catch (_) { throw new DomainError('idempotency_corrupt', 'İşlem yanıtı okunamıyor; inceleme gerekli.', 409); }
    return { key: normalizedKey, hash, duplicate: true, response };
  }

  function saveIdempotency(key, operation, hash, response) {
    run(`INSERT INTO idempotency_keys (idempotency_key, operation, request_hash, response_json, created_at)
         VALUES ($key, $operation, $hash, $response, $createdAt)`, {
      $key: key, $operation: operation, $hash: hash,
      $response: JSON.stringify(response), $createdAt: isoNow()
    });
  }

  function getConfig() {
    const rows = many("SELECT key, value FROM settings WHERE key IN ('card_removed_ms', 'payment_cooldown_ms', 'demo_mode') ORDER BY key");
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
        if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') throw new DomainError('invalid_value', `${key} boş bırakılamaz.`);
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
                    WHERE s.token = $token AND s.expires_at > $now AND u.locked = 0`, { $token: token, $now: isoNow() });
    return row ? publicUser(row) : null;
  }

  function revokeSession(token) {
    if (token) run('DELETE FROM sessions WHERE token = $token', { $token: token });
  }

  function setStaffLocked(userId, locked, actorUserId) {
    return withImmediateTransaction(() => {
      const user = one('SELECT * FROM users WHERE id = $id', { $id: userId });
      if (!user) throw new DomainError('user_not_found', 'Personel bulunamadı.', 404);
      if (user.role !== 'staff') throw new DomainError('staff_only', 'Yalnız demo personel hesapları değiştirilebilir.', 400);
      if (Boolean(user.locked) === locked) return publicUser(user);
      run('UPDATE users SET locked = $locked WHERE id = $id', { $locked: locked ? 1 : 0, $id: user.id });
      if (locked) {
        run('UPDATE sessions SET expires_at = $now WHERE user_id = $id AND expires_at > $now', { $id: user.id, $now: isoNow() });
        const reset = one('SELECT value FROM settings WHERE key = $key', { $key: `demo_password_reset:${user.id}` });
        if (reset) run('UPDATE settings SET value = $value WHERE key = $key', { $key: `demo_password_reset:${user.id}`, $value: JSON.stringify({ ...JSON.parse(reset.value), used: true }) });
      }
      audit(locked ? 'staff.disabled' : 'staff.enabled', actorUserId, { userId: user.id });
      return publicUser(one('SELECT * FROM users WHERE id = $id', { $id: user.id }));
    });
  }

  function issueDemoPasswordReset(userId, adminId, adminPassword) {
    return withImmediateTransaction(() => {
      const admin = one('SELECT * FROM users WHERE id = $id', { $id: adminId });
      if (!admin || admin.locked || admin.role !== 'admin' || !verifyPassword(String(adminPassword || ''), admin.password_hash)) throw new DomainError('reauth_failed', 'Yönetici doğrulaması başarısız.', 401);
      const user = one('SELECT * FROM users WHERE id = $id', { $id: userId });
      if (!user || user.role !== 'staff' || user.locked) throw new DomainError('staff_unavailable', 'Etkin demo personel hesabı bulunamadı.', 404);
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      run('INSERT INTO settings(key,value) VALUES($key,$value) ON CONFLICT(key) DO UPDATE SET value=excluded.value', {
        $key: `demo_password_reset:${user.id}`, $value: JSON.stringify({ tokenHash, expiresAt, used: false })
      });
      audit('staff.demo_reset_issued', adminId, { userId: user.id, expiresAt });
      return { token, expiresAt, username: user.username };
    });
  }

  function completeDemoPasswordReset(username, token, newPassword) {
    const password = typeof newPassword === 'string' ? newPassword : '';
    if (password.length < 10 || password.length > 256) throw new DomainError('weak_password', 'Yeni parola 10–256 karakter olmalıdır.');
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new DomainError('invalid_reset', 'Kod geçersiz, kullanılmış veya süresi dolmuş.', 400);
    return withImmediateTransaction(() => {
      const user = one('SELECT * FROM users WHERE username = $username', { $username: String(username || '').trim().toLowerCase() });
      const row = user && one('SELECT value FROM settings WHERE key = $key', { $key: `demo_password_reset:${user.id}` });
      const reset = row ? JSON.parse(row.value) : null;
      const actual = crypto.createHash('sha256').update(token).digest();
      const expected = Buffer.from(reset?.tokenHash || '', 'hex');
      if (!user || user.role !== 'staff' || user.locked || !reset || reset.used || reset.expiresAt <= isoNow() || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        throw new DomainError('invalid_reset', 'Kod geçersiz, kullanılmış veya süresi dolmuş.', 400);
      }
      run('UPDATE users SET password_hash = $hash WHERE id = $id', { $hash: hashPassword(password), $id: user.id });
      run('UPDATE settings SET value = $value WHERE key = $key', { $key: `demo_password_reset:${user.id}`, $value: JSON.stringify({ ...reset, used: true }) });
      run('UPDATE sessions SET expires_at = $now WHERE user_id = $id AND expires_at > $now', { $id: user.id, $now: isoNow() });
      audit('staff.demo_password_reset', user.id, { userId: user.id });
      return { ok: true };
    });
  }

  function createAccount({ name, phone = '', actorUserId = null }) {
    const normalizedName = String(name || '').trim();
    const normalizedPhone = String(phone || '').trim();
    if (normalizedName.length < 2 || normalizedName.length > 120) throw new DomainError('invalid_account_name', 'Hesap adı 2–120 karakter olmalıdır.');
    if (normalizedPhone.length > 40) throw new DomainError('invalid_phone', 'Telefon en fazla 40 karakter olmalıdır.');
    const id = makeId('acct');
    run('INSERT INTO accounts (id, name, created_at) VALUES ($id, $name, $createdAt)', { $id: id, $name: normalizedName, $createdAt: isoNow() });
    if (normalizedPhone) run('INSERT INTO account_contacts (account_id, phone) VALUES ($id, $phone)', { $id: id, $phone: normalizedPhone });
    audit('account.created', actorUserId, { accountId: id });
    return getAccount(id);
  }

  function getAccount(id) {
    const account = one('SELECT a.*, c.phone FROM accounts a LEFT JOIN account_contacts c ON c.account_id = a.id WHERE a.id = $id', { $id: id });
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

  function createDemoAccountCard({ name, phone, uid, idempotencyKey, actorUserId }) {
    const payload = { name: String(name || '').trim(), uid: normalizeUid(uid) };
    if (String(phone || '').trim()) payload.phone = String(phone).trim();
    return withImmediateTransaction(() => {
      const key = ensureIdempotency(idempotencyKey, 'demo_registration', payload);
      if (key.duplicate) return { ...key.response, duplicate: true };
      const account = createAccount({ name: payload.name, phone: payload.phone, actorUserId });
      const card = createCard({ uid: payload.uid, accountId: account.id, actorUserId });
      const response = { ok: true, account, card };
      saveIdempotency(key.key, 'demo_registration', key.hash, response);
      return response;
    });
  }

  function attachDemoCard({ accountId, uid, idempotencyKey, actorUserId }) {
    const payload = { accountId, uid: normalizeUid(uid), actorUserId };
    return withImmediateTransaction(() => {
      const key = ensureIdempotency(idempotencyKey, 'demo_attach_card', payload);
      if (key.duplicate) return { ...key.response, duplicate: true };
      const account = getAccount(accountId);
      if (account.locked) throw new DomainError('account_locked', 'Hesap kilitli.', 403);
      const card = createCard({ uid: payload.uid, accountId, actorUserId });
      const response = { ok: true, card };
      saveIdempotency(key.key, 'demo_attach_card', key.hash, response);
      return response;
    });
  }

  function setCardLock(uid, locked, actorUserId) {
    return withImmediateTransaction(() => {
      const card = getCard(uid);
      if (Boolean(card.locked) === locked) return card;
      run('UPDATE cards SET locked = $locked, updated_at = $updatedAt WHERE uid = $uid', { $uid: card.uid, $locked: locked ? 1 : 0, $updatedAt: isoNow() });
      audit(locked ? 'card.locked' : 'card.unlocked', actorUserId, { uid: card.uid });
      return getCard(card.uid);
    });
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
    const machine = one(`SELECT m.*, COALESCE(t.card_removed_ms, 1000) AS card_removed_ms,
                        COALESCE(t.payment_cooldown_ms, 500) AS payment_cooldown_ms
                        FROM machines m LEFT JOIN device_timing t ON t.machine_id = m.id WHERE m.id = $id`, { $id: String(id || '').trim().toUpperCase() });
    if (!machine) throw new DomainError('machine_not_found', 'Makine bulunamadı.', 404);
    const configRow = one('SELECT value FROM settings WHERE key = $key', { $key: `demo_led_config:${machine.id}` });
    const reportRow = one('SELECT value FROM settings WHERE key = $key', { $key: `demo_settings_report:${machine.id}` });
    const config = configRow ? JSON.parse(configRow.value) : { enabled: true, brightness: 128 };
    const report = reportRow ? JSON.parse(reportRow.value) : {};
    return { ...machine, led_enabled: config.enabled, led_brightness: config.brightness,
      settings_status: report.version === machine.settings_version ? report.status : 'pending',
      reported_version: report.version ?? null, simulated_led_enabled: report.applied?.enabled ?? false,
      simulated_led_brightness: report.applied?.brightness ?? 0, simulated_applied_version: report.applied?.version ?? null };
  }

  function setMachineLed(id, enabled, brightness, actorUserId) {
    if (typeof enabled !== 'boolean' || !Number.isInteger(brightness) || brightness < 0 || brightness > 255) throw new DomainError('invalid_led', 'LED etkinliği ve 0–255 arası tam sayı parlaklık gereklidir.');
    return withImmediateTransaction(() => {
      const machine = getMachine(id);
      if (machine.led_enabled === enabled && machine.led_brightness === brightness) return machine;
      run('INSERT INTO settings(key,value) VALUES($key,$value) ON CONFLICT(key) DO UPDATE SET value=excluded.value', { $key: `demo_led_config:${machine.id}`, $value: JSON.stringify({ enabled, brightness }) });
      run('UPDATE machines SET settings_version = settings_version + 1, updated_at = $now WHERE id = $id', { $id: machine.id, $now: isoNow() });
      audit('machine.demo_led_updated', actorUserId, { machineId: machine.id, enabled, brightness, settingsVersion: machine.settings_version + 1 });
      return getMachine(machine.id);
    });
  }

  function reportSimulatedSettings(id, version, status, actorUserId) {
    if (!Number.isSafeInteger(version) || !['applied', 'failed'].includes(status)) throw new DomainError('invalid_report', 'Geçerli sürüm ve sanal sonuç gereklidir.');
    return withImmediateTransaction(() => {
      const machine = getMachine(id);
      if (version !== machine.settings_version) throw new DomainError('stale_version', 'Ayar sürümü değişti; güncel sürümü seçin.', 409);
      const key = `demo_settings_report:${machine.id}`;
      const row = one('SELECT value FROM settings WHERE key = $key', { $key: key });
      const previous = row ? JSON.parse(row.value) : {};
      if (previous.version === version && previous.status === status) return machine;
      const applied = status === 'applied' ? { version, enabled: machine.led_enabled, brightness: machine.led_brightness } : (previous.applied || null);
      run('INSERT INTO settings(key,value) VALUES($key,$value) ON CONFLICT(key) DO UPDATE SET value=excluded.value', { $key: key, $value: JSON.stringify({ version, status, applied }) });
      audit('machine.simulated_settings_result', actorUserId, { machineId: machine.id, version, status });
      return getMachine(machine.id);
    });
  }

  function setMachineTiming(id, changes, actorUserId) {
    const read = (value, field) => {
      if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') throw new DomainError('invalid_value', `${field} boş bırakılamaz.`);
      return nonNegativeInteger(value, field, { max: 60000 });
    };
    const removed = read(changes.cardRemovedMs, 'card_removed_ms');
    const cooldown = read(changes.paymentCooldownMs, 'payment_cooldown_ms');
    return withImmediateTransaction(() => {
      const machine = getMachine(id);
      run(`INSERT INTO device_timing(machine_id, card_removed_ms, payment_cooldown_ms) VALUES ($id, $removed, $cooldown)
           ON CONFLICT(machine_id) DO UPDATE SET card_removed_ms = excluded.card_removed_ms, payment_cooldown_ms = excluded.payment_cooldown_ms`, { $id: machine.id, $removed: removed, $cooldown: cooldown });
      run('UPDATE machines SET settings_version = settings_version + 1, updated_at = $now WHERE id = $id', { $id: machine.id, $now: isoNow() });
      audit('machine.timing_updated', actorUserId, { machineId: machine.id, cardRemovedMs: removed, paymentCooldownMs: cooldown, settingsVersion: machine.settings_version + 1 });
      return getMachine(machine.id);
    });
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

  function verifyRecordedTopup(response, payload, actorUserId, idempotencyKey) {
    if (!response || typeof response !== 'object' || typeof response.entryId !== 'string') throw new DomainError('topup_history_inconsistent', 'Eski yükleme yanıtı tutarsız; inceleme gerekli.', 409);
    const original = one('SELECT actor_user_id, account_id, card_uid, amount_cents, entry_type, balance_after_cents, idempotency_key FROM ledger_entries WHERE id = $id', { $id: response.entryId });
    if (!original) throw new DomainError('topup_history_inconsistent', 'Eski yükleme kaydı eksik; inceleme gerekli.', 409);
    if (original.actor_user_id !== actorUserId) throw new DomainError('topup_owner_mismatch', 'Yüklemeyi başlatan kullanıcıyla giriş yapın.', 403);
    if (original.idempotency_key !== `${idempotencyKey}:ledger` || original.account_id !== payload.accountId || original.card_uid !== payload.cardUid || original.amount_cents !== payload.amountCents || original.entry_type !== payload.entryType || original.balance_after_cents !== response.balanceAfterCents || response.amountCents !== original.amount_cents || response.accountId !== original.account_id || response.entryType !== original.entry_type) throw new DomainError('topup_history_inconsistent', 'Eski yükleme kaydı tutarsız; inceleme gerekli.', 409);
  }

  function topUp({ accountId, cardUid = null, amountCents, idempotencyKey, actorUserId = null, entryType = 'topup', note = null, requireIntentForNew = false }) {
    amountCents = positiveInteger(amountCents, 'yükleme tutarı', { max: 9_000_000_000_000_000 });
    const payload = { accountId, cardUid: cardUid ? normalizeUid(cardUid) : null, amountCents, entryType, note: note || null };
    const result = withImmediateTransaction(() => {
      const idempotency = ensureIdempotency(idempotencyKey, 'topup', payload);
      const intentKey = `demo_topup_intent:${idempotency.key}`;
      const intentRow = one('SELECT value FROM settings WHERE key = $key', { $key: intentKey });
      const intent = intentRow ? JSON.parse(intentRow.value) : null;
      if (requireIntentForNew && !intent && !idempotency.duplicate) throw new DomainError('intent_required', 'Yeni demo yükleme için önce sunucuda niyet oluşturun.', 409);
      if (intent && (intent.id !== idempotency.key || !['prepared', 'completed'].includes(intent.status))) throw new DomainError('intent_inconsistent', 'Niyet kaydı tutarsız; inceleme gerekli.', 409);
      if (intent && (intent.actorUserId !== actorUserId || stableStringify(intent.payload) !== stableStringify(payload))) throw new DomainError('intent_conflict', 'Yükleme niyeti kullanıcı veya içerikle uyuşmuyor.', 409);
      if (intent) {
        const actor = one('SELECT role, locked FROM users WHERE id = $id', { $id: actorUserId });
        if (!actor || actor.locked || !['admin', 'staff'].includes(actor.role)) throw new DomainError('intent_owner_unavailable', 'Niyet sahibi etkin değil.', 403);
      }
      if (intent?.status === 'completed' && !idempotency.duplicate) throw new DomainError('intent_inconsistent', 'Tamamlanmış niyetin işlem kaydı eksik; inceleme gerekli.', 409);
      const finishIntent = response => {
        if (intent) run('UPDATE settings SET value = $value WHERE key = $key', { $key: intentKey, $value: JSON.stringify({ ...intent, status: 'completed', response, completedAt: intent.completedAt || isoNow() }) });
      };
      if (idempotency.duplicate) {
        verifyRecordedTopup(idempotency.response, payload, actorUserId, idempotency.key);
        finishIntent(idempotency.response);
        return { ...idempotency.response, duplicate: true };
      }
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
      if (options.testHook) options.testHook('topup_after_balance');
      const response = { ok: true, entryId, accountId, amountCents, balanceAfterCents, entryType };
      saveIdempotency(idempotency.key, 'topup', idempotency.hash, response);
      finishIntent(response);
      audit('balance.credited', actorUserId, { accountId, amountCents, entryType, entryId });
      return response;
    });
    if (options.testHook) options.testHook('topup_after_commit');
    return result;
  }

  function prepareDemoTopupIntent({ accountId, cardUid = null, amountCents, idempotencyKey, actorUserId }) {
    amountCents = positiveInteger(amountCents, 'yükleme tutarı', { max: 9_000_000_000_000_000 });
    const payload = { accountId, cardUid: cardUid ? normalizeUid(cardUid) : null, amountCents, entryType: 'topup', note: null };
    return withImmediateTransaction(() => {
      const actor = one('SELECT role, locked FROM users WHERE id = $id', { $id: actorUserId });
      if (!actor || actor.locked || !['admin', 'staff'].includes(actor.role)) throw new DomainError('intent_owner_unavailable', 'Niyet sahibi etkin değil.', 403);
      const key = ensureIdempotency(idempotencyKey, 'topup', payload);
      const intentKey = `demo_topup_intent:${key.key}`;
      const existing = one('SELECT value FROM settings WHERE key = $key', { $key: intentKey });
      if (existing) {
        const intent = JSON.parse(existing.value);
        if (intent.id !== key.key || !['prepared', 'completed'].includes(intent.status)) throw new DomainError('intent_inconsistent', 'Niyet kaydı tutarsız; inceleme gerekli.', 409);
        if (intent.actorUserId !== actorUserId) throw new DomainError('intent_owner_mismatch', 'Bu niyet başka kullanıcıya ait.', 403);
        if (stableStringify(intent.payload) !== stableStringify(payload)) throw new DomainError('intent_conflict', 'Aynı niyet farklı içerikle kullanılamaz.', 409);
        return { intent, duplicate: true };
      }
      if (key.duplicate) {
        verifyRecordedTopup(key.response, payload, actorUserId, key.key);
      }
      const account = getAccount(accountId);
      if (payload.cardUid && getCard(payload.cardUid).account_id !== account.id) throw new DomainError('card_account_mismatch', 'Kart bu hesaba bağlı değil.');
      const intent = { id: key.key, actorUserId, payload, status: key.duplicate ? 'completed' : 'prepared', createdAt: isoNow(), ...(key.duplicate ? { response: key.response, completedAt: isoNow() } : {}) };
      run('INSERT INTO settings(key,value) VALUES($key,$value)', { $key: intentKey, $value: JSON.stringify(intent) });
      audit('demo.topup_intent_prepared', actorUserId, { intentId: key.key, accountId });
      return { intent, duplicate: false };
    });
  }

  function listDemoTopupIntents(actorUserId) {
    return many(`SELECT value FROM settings WHERE key LIKE 'demo_topup_intent:%' AND json_extract(value, '$.actorUserId') = $actor
      AND json_extract(value, '$.status') = 'prepared' ORDER BY json_extract(value, '$.createdAt') DESC LIMIT 25`, { $actor: actorUserId }).map(row => JSON.parse(row.value));
  }

  function executeDemoTopupIntent(id, actorUserId) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(id)) throw new DomainError('invalid_idempotency_key', 'Geçersiz niyet kimliği.');
    const row = one('SELECT value FROM settings WHERE key = $key', { $key: `demo_topup_intent:${id}` });
    if (!row) throw new DomainError('intent_unknown', 'Niyet bulunamadı; sonuç bilinmiyor.', 404);
    const intent = JSON.parse(row.value);
    if (intent.id !== id || !['prepared', 'completed'].includes(intent.status)) throw new DomainError('intent_inconsistent', 'Niyet kaydı tutarsız; inceleme gerekli.', 409);
    if (intent.actorUserId !== actorUserId) throw new DomainError('intent_owner_mismatch', 'Bu niyet başka kullanıcıya ait.', 403);
    return topUp({ ...intent.payload, idempotencyKey: intent.id, actorUserId, requireIntentForNew: true });
  }

  function correctBalance({ accountId, amountCents, reason, idempotencyKey, actorUserId }) {
    if (!Number.isSafeInteger(amountCents) || amountCents === 0 || Math.abs(amountCents) > 9_000_000_000_000_000) throw new DomainError('invalid_amount', 'Düzeltme tutarı sıfırdan farklı tam kuruş olmalıdır.');
    const note = String(reason || '').trim();
    if (note.length < 10 || note.length > 1000) throw new DomainError('invalid_reason', 'Gerekçe 10–1000 karakter olmalıdır.');
    const payload = { accountId, amountCents, reason: note, actorUserId };
    return withImmediateTransaction(() => {
      const key = ensureIdempotency(idempotencyKey, 'correction', payload);
      if (key.duplicate) return { ...key.response, duplicate: true };
      const account = getAccount(accountId);
      const balanceAfterCents = account.tl_balance_cents + amountCents;
      if (!Number.isSafeInteger(balanceAfterCents) || balanceAfterCents < 0) throw new DomainError('invalid_balance', 'Düzeltme bakiyeyi eksiye düşüremez veya sayısal sınırı aşamaz.', 409);
      const entryId = makeId('led');
      run(`INSERT INTO ledger_entries (id, account_id, actor_user_id, entry_type, amount_cents, ticket_delta, balance_after_cents, idempotency_key, note, created_at)
           VALUES ($id, $account, $actor, 'correction', $amount, 0, $balance, $key, $note, $created)`, {
        $id: entryId, $account: accountId, $actor: actorUserId, $amount: amountCents, $balance: balanceAfterCents, $key: `${key.key}:ledger`, $note: note, $created: isoNow()
      });
      run('UPDATE accounts SET tl_balance_cents = $balance, updated_at = $updated WHERE id = $account', { $balance: balanceAfterCents, $updated: isoNow(), $account: accountId });
      audit('balance.corrected', actorUserId, { entryId, accountId, amountCents, reason: note });
      const response = { ok: true, entryId, accountId, amountCents, balanceAfterCents };
      saveIdempotency(key.key, 'correction', key.hash, response);
      return response;
    });
  }

  function pay({ machineId, cardUid, idempotencyKey, actorUserId = null, simulator = false }) {
    const payload = { machineId: String(machineId || '').trim().toUpperCase(), cardUid: normalizeUid(cardUid) };
    return withImmediateTransaction(() => {
      const idempotency = ensureIdempotency(idempotencyKey, 'payment', payload);
      if (idempotency.duplicate) return { ...idempotency.response, duplicate: true };
      const now = Date.now();
      const machine = getMachine(payload.machineId);
      if (simulator) {
        const state = getDeviceState(machine.id);
        if (!state.present || state.card_uid !== payload.cardUid) throw new DomainError('card_not_present', 'Kartı yaklaştırıp sabit tutun.', 409);
        if (state.payment_latched) throw new DomainError('card_hold_required', 'Yeni ödeme için kartı çekip yeniden yaklaştırmalısınız.', 409);
        if (now < state.eligible_at_ms) throw new DomainError('card_removed_wait', 'Kartın çekilme bekleme süresi dolmadı.', 409);
        if (now < state.cooldown_until_ms) throw new DomainError('payment_cooldown', 'Ödeme soğuma süresi devam ediyor.', 409);
      }
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
      if (options.testHook) options.testHook('after_balance');
      run(`INSERT INTO pulse_commands (id, machine_id, account_id, card_uid, actor_user_id, amount_cents,
           pulse_ms, pulse_count, pulse_gap_ms, status, attempt_count, idempotency_key, created_at, updated_at)
           VALUES ($id, $machineId, $accountId, $cardUid, $actorUserId, $amountCents, $pulseMs, $pulseCount, $pulseGapMs,
           'pending', 0, $idempotencyKey, $createdAt, $updatedAt)`, {
        $id: pulseCommandId, $machineId: machine.id, $accountId: card.account_id, $cardUid: card.uid, $actorUserId: actorUserId,
        $amountCents: priceCents, $pulseMs: machine.pulse_ms, $pulseCount: machine.pulse_count, $pulseGapMs: machine.pulse_gap_ms,
        $idempotencyKey: idempotency.key, $createdAt: isoNow(), $updatedAt: isoNow()
      });
      const response = { ok: true, approved: true, balanceAfterCents, priceCents, pulseCommandId, settingsVersion: machine.settings_version,
        demoLedSnapshot: { enabled: machine.led_enabled, brightness: machine.led_brightness },
        simulatedLedSnapshot: { version: machine.simulated_applied_version, enabled: machine.simulated_led_enabled, brightness: machine.simulated_led_brightness } };
      saveIdempotency(idempotency.key, 'payment', idempotency.hash, response);
      if (simulator) run('UPDATE device_simulator_state SET payment_latched = 1, last_payment_at_ms = $now, cooldown_until_ms = $until, updated_at = $updatedAt WHERE machine_id = $id', { $now: now, $until: now + machine.payment_cooldown_ms, $updatedAt: isoNow(), $id: machine.id });
      audit('payment.approved', actorUserId, { accountId: card.account_id, cardUid: card.uid, machineId: machine.id, pulseCommandId });
      if (options.testHook) options.testHook('before_commit');
      return response;
    });
  }

  function demoFreePlay({ machineId, cardUid, reason, idempotencyKey, actorUserId }) {
    const note = typeof reason === 'string' ? reason.trim() : '';
    if (note.length < 10 || note.length > 1000) throw new DomainError('invalid_reason', 'Gerekçe 10–1000 karakter olmalıdır.');
    const payload = { machineId: String(machineId || '').trim().toUpperCase(), cardUid: normalizeUid(cardUid), reason: note, actorUserId };
    return withImmediateTransaction(() => {
      const key = ensureIdempotency(idempotencyKey, 'demo_free_play', payload);
      if (key.duplicate) return { ...key.response, duplicate: true };
      const machine = getMachine(payload.machineId);
      const now = Date.now();
      const state = getDeviceState(machine.id);
      if (!state.present || state.card_uid !== payload.cardUid) throw new DomainError('card_not_present', 'Önce sanal kartı seçili cihaza yaklaştırın.', 409);
      if (state.payment_latched) throw new DomainError('card_hold_required', 'Yeni oyun için kartı çekip yeniden yaklaştırın.', 409);
      if (now < state.eligible_at_ms) throw new DomainError('card_removed_wait', 'Kartın çekilme bekleme süresi dolmadı.', 409);
      if (now < state.cooldown_until_ms) throw new DomainError('payment_cooldown', 'Oyun bekleme süresi devam ediyor.', 409);
      const card = getCard(payload.cardUid);
      if (!machine.enabled) throw new DomainError('machine_disabled', 'Makine pasif.', 409);
      if (card.locked || card.account_locked) throw new DomainError('card_locked', 'Kart veya hesap kilitli.', 403);
      const entryId = makeId('led'); const pulseCommandId = makeId('pulse'); const createdAt = isoNow();
      run(`INSERT INTO ledger_entries (id, account_id, card_uid, actor_user_id, entry_type, amount_cents, ticket_delta, balance_after_cents, idempotency_key, note, created_at)
        VALUES ($id,$account,$card,$actor,'free_play',0,0,$balance,$key,$note,$created)`, {
        $id: entryId, $account: card.account_id, $card: card.uid, $actor: actorUserId, $balance: card.tl_balance_cents,
        $key: `${key.key}:ledger`, $note: note, $created: createdAt
      });
      run(`INSERT INTO pulse_commands (id, machine_id, account_id, card_uid, actor_user_id, amount_cents, pulse_ms, pulse_count, pulse_gap_ms, status, attempt_count, idempotency_key, created_at, updated_at)
        VALUES ($id,$machine,$account,$card,$actor,0,$pulseMs,$pulseCount,$pulseGap,'pending',0,$key,$created,$created)`, {
        $id: pulseCommandId, $machine: machine.id, $account: card.account_id, $card: card.uid, $actor: actorUserId,
        $pulseMs: machine.pulse_ms, $pulseCount: machine.pulse_count, $pulseGap: machine.pulse_gap_ms, $key: key.key, $created: createdAt
      });
      const response = { ok: true, entryId, pulseCommandId, balanceAfterCents: card.tl_balance_cents, settingsVersion: machine.settings_version };
      saveIdempotency(key.key, 'demo_free_play', key.hash, response);
      run('UPDATE device_simulator_state SET payment_latched = 1, last_payment_at_ms = $now, cooldown_until_ms = $until, updated_at = $updatedAt WHERE machine_id = $id', { $now: now, $until: now + machine.payment_cooldown_ms, $updatedAt: createdAt, $id: machine.id });
      audit('demo.free_play', actorUserId, { entryId, pulseCommandId, accountId: card.account_id, machineId: machine.id, reason: note });
      return response;
    });
  }

  function getPulseCommand(commandId) {
    const command = one('SELECT * FROM pulse_commands WHERE id = $id', { $id: commandId });
    if (!command) throw new DomainError('pulse_not_found', 'Pulse komutu bulunamadı.', 404);
    return command;
  }

  function reviewPulse({ commandId, decision, reason, idempotencyKey, actorUserId }) {
    const payload = { commandId: String(commandId || ''), decision: String(decision || ''), reason: String(reason || '').trim(), actorUserId };
    if (!['reviewed_no_action', 'needs_follow_up'].includes(payload.decision)) throw new DomainError('invalid_decision', 'Geçerli bir inceleme kararı seçin.');
    if (payload.reason.length < 10 || payload.reason.length > 1000) throw new DomainError('invalid_reason', 'Gerekçe 10–1000 karakter olmalıdır.');
    return withImmediateTransaction(() => {
      const key = ensureIdempotency(idempotencyKey, 'pulse_review', payload);
      if (key.duplicate) return { ...key.response, duplicate: true };
      const command = getPulseCommand(payload.commandId);
      if (command.status !== 'ambiguous') throw new DomainError('not_ambiguous', 'Yalnızca belirsiz komutlar incelenebilir.', 409);
      if (one('SELECT id FROM pulse_reviews WHERE command_id = $commandId', { $commandId: command.id })) throw new DomainError('already_reviewed', 'Bu komut için inceleme zaten kaydedildi.', 409);
      const review = { id: makeId('review'), command_id: command.id, decision: payload.decision, reason: payload.reason, actor_user_id: actorUserId, created_at: isoNow() };
      run('INSERT INTO pulse_reviews (id, command_id, decision, reason, actor_user_id, created_at) VALUES ($id, $command, $decision, $reason, $actor, $created)', {
        $id: review.id, $command: review.command_id, $decision: review.decision, $reason: review.reason, $actor: actorUserId, $created: review.created_at
      });
      audit('pulse.review_recorded', actorUserId, { commandId: command.id, reviewId: review.id, decision: payload.decision });
      const response = { ok: true, review };
      saveIdempotency(key.key, 'pulse_review', key.hash, response);
      return response;
    });
  }

  function listPulseReviews() {
    return many('SELECT r.*, u.username AS actor_username FROM pulse_reviews r JOIN users u ON u.id = r.actor_user_id ORDER BY r.created_at DESC');
  }

  function getIdempotency(idempotencyKey) {
    const row = one('SELECT operation, response_json, created_at FROM idempotency_keys WHERE idempotency_key = $key', { $key: String(idempotencyKey || '') });
    return row ? { operation: row.operation, response: JSON.parse(row.response_json), createdAt: row.created_at } : null;
  }

  function lookupDemoTopup(idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) throw new DomainError('invalid_idempotency_key', 'İstek kimliği 8–200 güvenli karakter olmalıdır.');
    const entry = one(`SELECT i.response_json, l.id, l.created_at, l.account_id, l.card_uid, l.amount_cents,
      l.balance_after_cents, l.entry_type, u.username AS actor
      FROM idempotency_keys i LEFT JOIN ledger_entries l ON l.idempotency_key = i.idempotency_key || ':ledger'
      LEFT JOIN users u ON u.id = l.actor_user_id
      WHERE i.idempotency_key = $key AND i.operation = 'topup'`, { $key: idempotencyKey });
    if (!entry) return { status: 'unknown' };
    let response;
    try { response = JSON.parse(entry.response_json); } catch (_) { return { status: 'inconsistent' }; }
    if (!entry.id || entry.entry_type !== 'topup' || response.entryId !== entry.id || response.accountId !== entry.account_id || response.amountCents !== entry.amount_cents || response.balanceAfterCents !== entry.balance_after_cents) return { status: 'inconsistent' };
    return { status: 'recorded', entry: { id: entry.id, created_at: entry.created_at, account_id: entry.account_id, card_uid: entry.card_uid, amount_cents: entry.amount_cents, balance_after_cents: entry.balance_after_cents, actor: entry.actor } };
  }

  function recentRecordedDemoTopups(actorUserId = null) {
    const scope = actorUserId ? 'AND l.actor_user_id = $actor' : '';
    const params = actorUserId ? { $actor: actorUserId } : {};
    const rows = many(`SELECT i.idempotency_key AS request_key FROM ledger_entries l
      JOIN idempotency_keys i ON l.idempotency_key = i.idempotency_key || ':ledger' AND i.operation = 'topup'
      WHERE l.entry_type = 'topup' ${scope} ORDER BY l.created_at DESC, l.id DESC LIMIT 25`, params);
    return rows.map(row => ({ request_key: row.request_key, ...lookupDemoTopup(row.request_key) }));
  }

  function simulatePulse(commandId, outcome, actorUserId = null) {
    if (!['succeeded', 'response_lost', 'connection_lost', 'failed'].includes(outcome)) {
      throw new DomainError('invalid_pulse_outcome', 'Geçersiz simülasyon sonucu.');
    }
    return withImmediateTransaction(() => {
      const command = getPulseCommand(commandId);
      if (command.status === 'succeeded') return command;
      if (command.status !== 'pending') throw new DomainError('pulse_review_required', 'Komut inceleme bekliyor; otomatik sonuç değiştirilemez.', 409);
      const status = outcome === 'succeeded' ? 'succeeded' : outcome === 'failed' ? 'failed' : 'ambiguous';
      run('UPDATE pulse_commands SET status = $status, last_outcome = $outcome, updated_at = $updatedAt WHERE id = $id', {
        $id: command.id, $status: status, $outcome: outcome, $updatedAt: isoNow()
      });
      audit(status === 'ambiguous' ? 'pulse.review_required' : 'pulse.simulated', actorUserId, { commandId, outcome, status });
      return getPulseCommand(commandId);
    });
  }

  function retryPulse(commandId, actorUserId = null) {
    const command = getPulseCommand(commandId);
    if (command.status === 'succeeded') return command;
    if (command.status !== 'pending') throw new DomainError('pulse_review_required', 'Belirsiz veya başarısız komut inceleme bekliyor; otomatik tekrar yok.', 409);
    run('UPDATE pulse_commands SET status = \'pending\', attempt_count = attempt_count + 1, last_outcome = NULL, updated_at = $updatedAt WHERE id = $id', {
      $id: command.id, $updatedAt: isoNow()
    });
    audit('pulse.retry', actorUserId, { commandId, attempt: command.attempt_count + 1 });
    return getPulseCommand(commandId);
  }

  function listAccounts() {
    return many(`SELECT a.*, contact.phone, COUNT(c.uid) AS card_count FROM accounts a LEFT JOIN account_contacts contact ON contact.account_id = a.id LEFT JOIN cards c ON c.account_id = a.id
                 GROUP BY a.id ORDER BY a.created_at DESC`);
  }

  function listCards() {
    return many(`SELECT c.uid, c.account_id, c.locked, c.created_at, a.name AS account_name, a.tl_balance_cents, a.ticket_balance,
                 a.locked AS account_locked FROM cards c JOIN accounts a ON a.id = c.account_id ORDER BY c.created_at DESC`);
  }

  function listMachines() { return many('SELECT id FROM machines ORDER BY id').map(row => getMachine(row.id)); }

  function getDeviceState(machineId = 'DEMO-MACHINE') {
    const machine = getMachine(machineId);
    run('INSERT OR IGNORE INTO device_simulator_state(machine_id, updated_at) VALUES ($id, $now)', { $id: machine.id, $now: isoNow() });
    return one('SELECT * FROM device_simulator_state WHERE machine_id = $id', { $id: machine.id });
  }

  function setDeviceState(state, machineId = 'DEMO-MACHINE') {
    const current = getDeviceState(machineId);
    run(`UPDATE device_simulator_state SET card_uid=$uid, present=$present, removed_at_ms=$removed,
         eligible_at_ms=$eligible, payment_latched=$latched, last_payment_at_ms=$last, cooldown_until_ms=$cooldown, updated_at=$now WHERE machine_id=$id`, {
      $id: current.machine_id, $uid: state.cardUid || null, $present: state.present ? 1 : 0,
      $removed: state.removedAtMs || 0, $eligible: state.eligibleAtMs || 0, $latched: state.paymentLatched ? 1 : 0,
      $last: state.lastPaymentAtMs || 0, $cooldown: state.cooldownUntilMs ?? current.cooldown_until_ms, $now: isoNow()
    });
    return getDeviceState(machineId);
  }

  function listLedger({ actorUserId = null, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    if (actorUserId) return many(`SELECT * FROM ledger_entries WHERE actor_user_id = $actorUserId ORDER BY created_at DESC LIMIT ${safeLimit}`, { $actorUserId: actorUserId });
    return many(`SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT ${safeLimit}`);
  }

  function detailedLedger({ from = '', to = '', machineId = '', type = '', page = 1, exportAll = false } = {}) {
    for (const value of [from, to, machineId, type]) if (typeof value !== 'string') throw new DomainError('invalid_filter', 'Geçersiz filtre.');
    if (from && to && from > to) throw new DomainError('invalid_date_range', 'Başlangıç tarihi bitiş tarihinden sonra olamaz.');
    if (type && !['topup', 'game_charge', 'correction', 'refund', 'bonus', 'free_play'].includes(type)) throw new DomainError('invalid_type', 'Geçersiz işlem türü.');
    if (machineId && !/^[A-Z0-9_-]{2,64}$/.test(machineId)) throw new DomainError('invalid_machine_id', 'Geçersiz cihaz.');
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new DomainError('invalid_page', 'Geçersiz sayfa.');
    const conditions = [];
    const params = {};
    if (from) { conditions.push('l.created_at >= $from'); params.$from = istanbulDayBounds(from).start; }
    if (to) { conditions.push('l.created_at < $to'); params.$to = istanbulDayBounds(to).end; }
    if (machineId) { conditions.push('p.machine_id = $machine'); params.$machine = machineId; }
    if (type) { conditions.push('l.entry_type = $type'); params.$type = type; }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const joins = `FROM ledger_entries l LEFT JOIN pulse_commands p ON l.idempotency_key = p.idempotency_key || ':ledger'
      LEFT JOIN machines m ON m.id = p.machine_id LEFT JOIN users u ON u.id = l.actor_user_id LEFT JOIN accounts a ON a.id = l.account_id`;
    // Keep the count and exported rows in one read snapshot, even if another process writes.
    db.exec('BEGIN');
    try {
      const count = one(`SELECT COUNT(*) AS count ${joins} ${where}`, params).count;
      const limit = exportAll ? 5000 : 25;
      if (exportAll && count > limit) throw new DomainError('export_limit', 'CSV için en fazla 5000 hareket seçin; tarih veya diğer filtreleri daraltın.', 400);
      const rows = many(`SELECT l.id, l.created_at, l.entry_type, l.amount_cents, l.balance_after_cents,
        l.account_id, a.name AS account_name, l.card_uid, l.note, u.username AS actor, p.id AS command_id,
        p.machine_id, m.name AS machine_name, p.status AS command_status
        ${joins} ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT $limit OFFSET $offset`, { ...params, $limit: limit, $offset: exportAll ? 0 : (page - 1) * limit });
      db.exec('COMMIT');
      return { rows, total: count, page, pageSize: limit, filters: { from, to, machineId, type } };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* preserve original error */ }
      throw error;
    }
  }

  function listPulses(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return many(`SELECT * FROM pulse_commands ORDER BY created_at DESC LIMIT ${safeLimit}`);
  }

  function summary() {
    const row = one(`SELECT
      COALESCE(SUM(CASE WHEN entry_type = 'topup' THEN amount_cents ELSE 0 END), 0) AS topups_cents,
      COALESCE(SUM(CASE WHEN entry_type = 'game_charge' THEN -amount_cents ELSE 0 END), 0) AS game_charges_cents,
      COALESCE(SUM(CASE WHEN entry_type = 'correction' THEN amount_cents ELSE 0 END), 0) AS corrections_cents,
      COALESCE(SUM(CASE WHEN entry_type = 'bonus' THEN amount_cents ELSE 0 END), 0) AS bonuses_cents,
      COALESCE(SUM(CASE WHEN entry_type = 'free_play' THEN -amount_cents ELSE 0 END), 0) AS free_play_cents,
      COALESCE(SUM(CASE WHEN entry_type = 'free_play' THEN 1 ELSE 0 END), 0) AS free_plays_count,
      COUNT(*) AS ledger_count FROM ledger_entries`);
    return { ...row, accountCount: one('SELECT COUNT(*) AS count FROM accounts').count, cardCount: one('SELECT COUNT(*) AS count FROM cards').count, machineCount: one('SELECT COUNT(*) AS count FROM machines').count, pulseCount: one('SELECT COUNT(*) AS count FROM pulse_commands').count };
  }

  function periodReport(period, now = new Date(), selectedDate) {
    if (!['day', 'week', 'month', 'year'].includes(period)) throw new DomainError('invalid_period', 'Geçersiz rapor dönemi.');
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const parts = date => Object.fromEntries(formatter.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
    const localStamp = date => { const p = parts(date); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };
    const selected = selectedDate === undefined ? localStamp(now).slice(0, 10) : selectedDate;
    if (typeof selected !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(selected)) throw new DomainError('invalid_date', 'Tarih YYYY-AA-GG biçiminde olmalıdır.');
    const [year, month, day] = selected.split('-').map(Number);
    const start = new Date(Date.UTC(year, month - 1, day));
    if (year < 1900 || year > 9998 || start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) throw new DomainError('invalid_date', 'Geçerli bir tarih seçin (1900–9998).');
    if (period === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
    if (period === 'month' || period === 'year') start.setUTCDate(1);
    if (period === 'year') start.setUTCMonth(0);
    const end = new Date(start);
    if (period === 'day') end.setUTCDate(end.getUTCDate() + 1);
    if (period === 'week') end.setUTCDate(end.getUTCDate() + 7);
    if (period === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
    if (period === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
    const stamp = date => date.toISOString().slice(0, 19).replace('T', ' ');
    // Convert each civil midnight with IANA timezone rules, including historical DST.
    const midnightUtc = civil => {
      const target = civil.getTime();
      let instant = target;
      for (let i = 0; i < 5; i++) {
        const p = parts(new Date(instant));
        const actual = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
        const next = instant + target - actual;
        if (next === instant) break;
        instant = next;
      }
      if (localStamp(new Date(instant)) !== stamp(civil)) throw new DomainError('invalid_date', 'Bu dönemin yerel saat sınırı belirlenemedi.');
      return new Date(instant).toISOString();
    };
    const params = { $start: midnightUtc(start), $end: midnightUtc(end), $now: now.toISOString() };
    const rows = many(`SELECT l.entry_type, l.amount_cents, l.created_at, p.machine_id, p.status, m.name
      FROM ledger_entries l LEFT JOIN pulse_commands p ON l.idempotency_key = p.idempotency_key || ':ledger'
      LEFT JOIN machines m ON m.id = p.machine_id
      WHERE l.created_at >= $start AND l.created_at < $end AND l.created_at <= $now`, params);
    const totals = { topups_cents: 0, game_charges_cents: 0, corrections_cents: 0, free_plays_count: 0 };
    const commandStatus = { succeeded: 0, ambiguous: 0, pending: 0, failed: 0, missing: 0 };
    const byBucket = new Map();
    const byMachine = new Map();
    for (const row of rows) {
      if (row.entry_type === 'topup') totals.topups_cents += row.amount_cents;
      if (row.entry_type === 'correction') totals.corrections_cents += row.amount_cents;
      if (row.entry_type === 'free_play') totals.free_plays_count++;
      if (row.entry_type !== 'game_charge') continue;
      const cents = -row.amount_cents;
      totals.game_charges_cents += cents;
      commandStatus[row.status || 'missing'] += cents;
      const local = localStamp(new Date(row.created_at));
      const key = period === 'day' ? local.slice(0, 13) + ':00' : period === 'year' ? local.slice(0, 7) : local.slice(0, 10);
      byBucket.set(key, (byBucket.get(key) || 0) + cents);
      const machineId = row.machine_id || null;
      if (!byMachine.has(machineId)) byMachine.set(machineId, { machine_id: machineId, name: row.name || 'Cihazı belirlenemeyen', cents: 0 });
      byMachine.get(machineId).cents += cents;
    }
    const buckets = [];
    for (const cursor = new Date(start); cursor < end;) {
      const key = period === 'day' ? stamp(cursor).slice(0, 13) + ':00' : period === 'year' ? stamp(cursor).slice(0, 7) : stamp(cursor).slice(0, 10);
      buckets.push({ label: key, cents: byBucket.get(key) || 0 });
      if (period === 'day') cursor.setUTCHours(cursor.getUTCHours() + 1);
      else if (period === 'year') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      else cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const machines = [...byMachine.values()].sort((a, b) => b.cents - a.cents || String(a.machine_id).localeCompare(String(b.machine_id)));
    return { period, selectedDate: selected, timezone: 'Europe/Istanbul', start: stamp(start), end: stamp(end), totals, commandStatus, buckets, machines,
      balance_cents: one('SELECT COALESCE(SUM(tl_balance_cents),0) AS cents FROM accounts').cents };
  }

  function close() { db.close(); }

  return {
    dbPath: resolvedPath, close, getConfig, setConfig, createUser, authenticate, sessionUser, revokeSession, setStaffLocked, issueDemoPasswordReset, completeDemoPasswordReset,
    createAccount, createDemoAccountCard, attachDemoCard, getAccount, listAccounts, createCard, getCard, setCardLock, listCards,
    createMachine, getMachine, updateMachine, setMachineTiming, setMachineLed, reportSimulatedSettings, listMachines, topUp, prepareDemoTopupIntent, listDemoTopupIntents, executeDemoTopupIntent, correctBalance, pay, demoFreePlay, getPulseCommand, simulatePulse,
    retryPulse, reviewPulse, listPulseReviews, getIdempotency, lookupDemoTopup, recentRecordedDemoTopups, listLedger, detailedLedger, listPulses, summary, periodReport, getUserCount: () => one('SELECT COUNT(*) AS count FROM users').count,
    getUsers: () => many('SELECT id, username, role, locked, created_at FROM users ORDER BY created_at'),
    getDemoState: getDeviceState,
    setDemoState: setDeviceState,
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
  db.exec(`CREATE TABLE IF NOT EXISTS pulse_reviews (id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE REFERENCES pulse_commands(id), decision TEXT NOT NULL CHECK(decision IN ('reviewed_no_action', 'needs_follow_up')), reason TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, $now)').run({ $now: isoNow() });
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 3').get()) {
      db.exec(`CREATE TABLE device_timing (machine_id TEXT PRIMARY KEY REFERENCES machines(id), card_removed_ms INTEGER NOT NULL CHECK(card_removed_ms BETWEEN 0 AND 60000), payment_cooldown_ms INTEGER NOT NULL CHECK(payment_cooldown_ms BETWEEN 0 AND 60000));
        CREATE TABLE device_simulator_state (machine_id TEXT PRIMARY KEY REFERENCES machines(id), card_uid TEXT, present INTEGER NOT NULL DEFAULT 0, removed_at_ms INTEGER NOT NULL DEFAULT 0, eligible_at_ms INTEGER NOT NULL DEFAULT 0, payment_latched INTEGER NOT NULL DEFAULT 0, last_payment_at_ms INTEGER NOT NULL DEFAULT 0, cooldown_until_ms INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
        INSERT INTO device_timing SELECT id, COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key='card_removed_ms'), 1000), COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key='payment_cooldown_ms'), 500) FROM machines;
        INSERT INTO device_simulator_state SELECT 'DEMO-MACHINE', card_uid, present, removed_at_ms, eligible_at_ms, payment_latched, last_payment_at_ms, CASE WHEN last_payment_at_ms = 0 THEN 0 ELSE last_payment_at_ms + COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key='payment_cooldown_ms'), 500) END, updated_at FROM simulator_state WHERE id=1 AND EXISTS (SELECT 1 FROM machines WHERE id='DEMO-MACHINE');`);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(3, $now)').run({ $now: isoNow() });
    }
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 4').get()) {
      db.exec('CREATE TABLE account_contacts (account_id TEXT PRIMARY KEY REFERENCES accounts(id), phone TEXT NOT NULL)');
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(4, $now)').run({ $now: isoNow() });
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
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
