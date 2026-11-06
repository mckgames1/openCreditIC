'use strict';

const path = require('node:path');
const express = require('express');
const { createStore, DomainError, parseMoneyCents, formatMoney, normalizeUid } = require('./core');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 1787;

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `phase1_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'phase1_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function publicMachine(machine) {
  return machine ? {
    ...machine,
    enabled: Boolean(machine.enabled),
    priceTl: formatMoney(machine.price_cents)
  } : null;
}

function publicCard(card) {
  return card ? {
    ...card,
    locked: Boolean(card.locked),
    account_locked: Boolean(card.account_locked),
    balanceTl: formatMoney(card.tl_balance_cents)
  } : null;
}

// Semicolon CSV with UTF-8 BOM for Turkish Excel. Only trusted integer amounts
// are emitted as numbers; every text cell is quoted and formula-like text neutralized.
function textCell(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f\u007f\ufeff]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function money(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('Invalid report amount');
  const value = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(value / 100)},${String(value % 100).padStart(2, '0')}`;
}
function reportCsv(report, generatedAt) {
  const rows = [];
  const row = (section, label, device, amount) => rows.push([textCell(section), textCell(label), textCell(device), amount === undefined ? '' : money(amount)].join(';'));
  rows.push([textCell('Bölüm'), textCell('İşlem türü / açıklama'), textCell('Cihaz / değer'), textCell('Tutar (TL)')].join(';'));
  row('Bilgi', 'Rapor', 'Yalnız demo; gerçek gelir veya fiziksel kredi değildir');
  row('Bilgi', 'Oluşturulma zamanı (UTC)', generatedAt.toISOString());
  row('Dönem', 'Seçilen tarih (İstanbul)', report.selectedDate);
  row('Dönem', 'Dönem türü', { day: 'Günlük', week: 'Haftalık', month: 'Aylık', year: 'Yıllık' }[report.period]);
  row('Dönem', 'Başlangıç (İstanbul, dahil)', report.start);
  row('Dönem', 'Bitiş (İstanbul, hariç)', report.end);
  row('İşlem özeti', 'Yükleme', '', report.totals.topups_cents);
  row('İşlem özeti', 'Oyun harcaması', '', report.totals.game_charges_cents);
  row('İşlem özeti', 'Net bakiye düzeltmesi', '', report.totals.corrections_cents);
  row('İşlem özeti', 'Ücretsiz demo oyun adedi', String(report.totals.free_plays_count ?? 0));
  row('Anlık durum', 'Şu anki toplam bakiye; dönem sonu bakiyesi değildir', '', report.balance_cents);
  for (const [status, label] of Object.entries({ ambiguous: 'Belirsiz', pending: 'Bekleyen', failed: 'Başarısız', missing: 'Komut kaydı yok', succeeded: 'Sanal olarak başarılı' })) {
    row('Oyun harcaması komut durumu (anlık)', label, '', report.commandStatus[status]);
  }
  for (const machine of report.machines) row('Cihaz bazlı oyun harcaması', machine.name, machine.machine_id || 'Bilinmiyor', machine.cents);
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}

function detailedCsv(result) {
  const header = ['Zaman (UTC)', 'İşlem türü', 'Tutar (TL)', 'İşlem sonrası hesap bakiyesi (TL)', 'Hesap kimliği', 'Kart UID', 'Personel', 'Cihaz kimliği', 'Cihaz adı', 'Sanal komut durumu (anlık)', 'Komut kimliği', 'İşlem kimliği', 'Not'];
  const lines = [header.map(textCell).join(';')];
  for (const row of result.rows) {
    lines.push([textCell(row.created_at), textCell(row.entry_type), money(row.amount_cents), money(row.balance_after_cents), textCell(row.account_id), textCell(row.card_uid), textCell(row.actor), textCell(row.machine_id), textCell(row.machine_name), textCell(row.command_status), textCell(row.command_id), textCell(row.id), textCell(row.note)].join(';'));
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

function currentUser(req, store) {
  const cookies = parseCookies(req.headers.cookie);
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return store.sessionUser(bearer || cookies.phase1_session);
}

function createApp({ store, standalone = true }) {
  if (!store) throw new Error('createApp requires a Phase 1 store');
  const app = express();
  const mountPath = standalone ? '/phase1' : '/';
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.set('view engine', 'pug');
  app.set('views', path.join(__dirname, '../web/views'));
  app.use(mountPath, express.static(path.join(__dirname, 'public'), { redirect: false, index: false }));

  function sendError(res, error) {
    if (error instanceof DomainError) {
      return res.status(error.status).json({ ok: false, error: error.code, message: error.message, details: error.details });
    }
    console.error(error);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Beklenmeyen sunucu hatası.' });
  }

  function requireAuth(req, res, next) {
    const user = currentUser(req, store);
    if (!user) return res.status(401).json({ ok: false, error: 'auth_required', message: 'Önce giriş yapmalısınız.' });
    req.user = user;
    return next();
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ ok: false, error: 'forbidden', message: 'Bu işlem için yetkiniz yok.' });
      return next();
    };
  }

  function handle(handler) {
    return async (req, res) => {
      try { await handler(req, res); } catch (error) { sendError(res, error); }
    };
  }

  app.get('/api/setup/status', handle(async (_req, res) => {
    res.json({ ok: true, setupRequired: store.getUserCount() === 0, demoMode: true });
  }));

  app.get('/home', (_req, res) => res.render('home', {
    demoMode: true, config: { arcade_name: 'mck_mifare', show_delete_actions: false },
    pos_terminals: [], machine_dispense: [], db: {}
  }));

  app.post('/api/setup', handle(async (req, res) => {
    if (store.getUserCount() !== 0) throw new DomainError('setup_closed', 'İlk yönetici kurulumu zaten tamamlandı.', 409);
    const user = store.createUser({ username: req.body.username, password: req.body.password, role: 'admin' });
    const login = store.authenticate(req.body.username, req.body.password);
    setSessionCookie(res, login.token);
    res.status(201).json({ ok: true, user, setupRequired: false });
  }));

  app.post('/api/auth/login', handle(async (req, res) => {
    const login = store.authenticate(req.body.username, req.body.password);
    setSessionCookie(res, login.token);
    res.json({ ok: true, user: login.user, expiresAt: login.expiresAt });
  }));

  app.post('/api/auth/demo-password-reset', handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(store.completeDemoPasswordReset(req.body.username, req.body.token, req.body.newPassword));
  }));

  app.post('/api/auth/logout', handle(async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || cookies.phase1_session;
    store.revokeSession(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  app.get('/api/state', requireAuth, handle(async (req, res) => {
    const simulator = store.getDemoState(req.query.machineId || 'DEMO-MACHINE');
    const state = {
      ok: true,
      user: req.user,
      config: store.getConfig(),
      accounts: store.listAccounts(),
      cards: store.listCards().map(publicCard),
      machines: store.listMachines().map(publicMachine),
      summary: req.user.role === 'admin' ? store.summary() : null,
      simulator: { ...simulator, present: Boolean(simulator.present), payment_latched: Boolean(simulator.payment_latched) },
      ledger: store.listLedger({ actorUserId: req.user.role === 'staff' ? req.user.id : null, limit: 25 }),
      pulses: req.user.role === 'admin' ? store.listPulses(25) : [],
      reviews: req.user.role === 'admin' ? store.listPulseReviews() : [],
      staff: req.user.role === 'admin' ? store.getUsers().filter(user => user.role === 'staff') : []
    };
    res.json(state);
  }));

  app.post('/api/admin/users', requireAuth, requireRole('admin'), handle(async (req, res) => {
    const user = store.createUser({ username: req.body.username, password: req.body.password, role: req.body.role || 'staff' });
    store.audit('user.created', req.user.id, { userId: user.id, role: user.role });
    res.status(201).json({ ok: true, user });
  }));

  app.post('/api/admin/staff/:id/lock', requireAuth, requireRole('admin'), handle(async (req, res) => {
    if (typeof req.body.locked !== 'boolean') throw new DomainError('invalid_lock_state', 'Hesap durumu true veya false olmalıdır.');
    res.json({ ok: true, user: store.setStaffLocked(req.params.id, req.body.locked, req.user.id) });
  }));

  app.post('/api/admin/staff/:id/demo-password-reset', requireAuth, requireRole('admin'), handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...store.issueDemoPasswordReset(req.params.id, req.user.id, req.body.adminPassword) });
  }));

  app.post('/api/accounts', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    res.status(201).json({ ok: true, account: store.createAccount({ name: req.body.name, actorUserId: req.user.id }) });
  }));

  app.post('/api/demo/register', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    const result = store.createDemoAccountCard({ name: req.body.name, uid: req.body.uid, idempotencyKey: req.body.idempotencyKey, actorUserId: req.user.id });
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  app.post('/api/demo/attach-card', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    const result = store.attachDemoCard({ accountId: req.body.accountId, uid: req.body.uid, idempotencyKey: req.body.idempotencyKey, actorUserId: req.user.id });
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  app.post('/api/cards', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    res.status(201).json({ ok: true, card: publicCard(store.createCard({ uid: req.body.uid, accountId: req.body.accountId, actorUserId: req.user.id })) });
  }));

  app.post('/api/cards/:uid/lock', requireAuth, requireRole('admin'), handle(async (req, res) => {
    if (typeof req.body.locked !== 'boolean') throw new DomainError('invalid_lock_state', 'Kart durumu true veya false olmalıdır.');
    res.json({ ok: true, card: publicCard(store.setCardLock(req.params.uid, req.body.locked, req.user.id)) });
  }));

  app.post('/api/machines', requireAuth, requireRole('admin'), handle(async (req, res) => {
    res.status(201).json({ ok: true, machine: publicMachine(store.createMachine({
      id: req.body.id, name: req.body.name, priceCents: parseMoneyCents(req.body.priceTl ?? req.body.price, 'fiyat'),
      pulseMs: req.body.pulseMs, pulseCount: req.body.pulseCount, pulseGapMs: req.body.pulseGapMs, actorUserId: req.user.id
    })) });
  }));

  app.patch('/api/machines/:id', requireAuth, requireRole('admin'), handle(async (req, res) => {
    const changes = {};
    if (req.body.name !== undefined) changes.name = req.body.name;
    if (req.body.priceTl !== undefined || req.body.price !== undefined) changes.priceCents = parseMoneyCents(req.body.priceTl ?? req.body.price, 'fiyat');
    if (req.body.pulseMs !== undefined) changes.pulseMs = req.body.pulseMs;
    if (req.body.pulseCount !== undefined) changes.pulseCount = req.body.pulseCount;
    if (req.body.pulseGapMs !== undefined) changes.pulseGapMs = req.body.pulseGapMs;
    if (req.body.enabled !== undefined) changes.enabled = req.body.enabled;
    res.json({ ok: true, machine: publicMachine(store.updateMachine(req.params.id, changes, req.user.id)) });
  }));

  app.patch('/api/admin/settings', requireAuth, requireRole('admin'), handle(async (req, res) => {
    res.status(410).json({ ok: false, error: 'device_settings_required', message: 'Süreler artık cihaz bazında ayarlanır.' });
  }));

  app.patch('/api/machines/:id/timing', requireAuth, requireRole('admin'), handle(async (req, res) => {
    res.json({ ok: true, machine: publicMachine(store.setMachineTiming(req.params.id, req.body, req.user.id)) });
  }));

  app.patch('/api/machines/:id/led', requireAuth, requireRole('admin'), handle(async (req, res) => {
    res.json({ ok: true, machine: publicMachine(store.setMachineLed(req.params.id, req.body.enabled, req.body.brightness, req.user.id)) });
  }));

  app.post('/api/demo/machines/:id/settings-result', requireAuth, requireRole('admin'), handle(async (req, res) => {
    res.json({ ok: true, machine: publicMachine(store.reportSimulatedSettings(req.params.id, req.body.version, req.body.status, req.user.id)) });
  }));

  app.post('/api/topups', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    const amountCents = parseMoneyCents(req.body.amountTl ?? req.body.amount, 'yükleme');
    const result = store.topUp({ accountId: req.body.accountId, cardUid: req.body.cardUid || null, amountCents, idempotencyKey: req.body.idempotencyKey, actorUserId: req.user.id, requireIntentForNew: true });
    res.status(result.duplicate ? 200 : 201).json({ ...result, amountTl: formatMoney(result.amountCents), balanceAfterTl: formatMoney(result.balanceAfterCents) });
  }));

  app.post('/api/demo/topup-intents', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const result = store.prepareDemoTopupIntent({ accountId: req.body.accountId, cardUid: req.body.cardUid || null, amountCents: parseMoneyCents(req.body.amountTl, 'yükleme'), idempotencyKey: req.body.idempotencyKey, actorUserId: req.user.id });
    res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
  }));

  app.get('/api/demo/topup-intents', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, intents: store.listDemoTopupIntents(req.user.id) });
  }));

  app.post('/api/demo/topup-intents/execute', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const result = store.executeDemoTopupIntent(req.body.intentId, req.user.id);
    res.status(result.duplicate ? 200 : 201).json({ ...result, amountTl: formatMoney(result.amountCents), balanceAfterTl: formatMoney(result.balanceAfterCents) });
  }));

  // POST keeps the request identifier out of URLs; this endpoint never mutates data.
  app.post('/api/admin/topups/lookup', requireAuth, requireRole('admin'), handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...store.lookupDemoTopup(req.body.idempotencyKey) });
  }));

  app.get('/api/demo/topups/recorded', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, records: store.recentRecordedDemoTopups(req.user.role === 'admin' ? null : req.user.id) });
  }));

  app.post('/api/admin/corrections', requireAuth, requireRole('admin'), handle(async (req, res) => {
    if (!['add', 'subtract'].includes(req.body.direction)) throw new DomainError('invalid_direction', 'Düzeltme yönü geçersiz.');
    const amount = parseMoneyCents(req.body.amountTl, 'düzeltme');
    const result = store.correctBalance({ accountId: req.body.accountId, amountCents: req.body.direction === 'subtract' ? -amount : amount, reason: req.body.reason, idempotencyKey: req.body.idempotencyKey, actorUserId: req.user.id });
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  app.post('/api/demo/simulator/card', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    const action = String(req.body.action || '').trim();
    const uid = normalizeUid(req.body.cardUid || 'DEMO-0001');
    const now = Date.now();
    const machine = store.getMachine(req.body.machineId || 'DEMO-MACHINE');
    const state = store.getDemoState(machine.id);
    if (action === 'approach') {
      const withinRemovalWindow = state.card_uid === uid && state.removed_at_ms > 0 && now < state.eligible_at_ms;
      if (state.present && state.card_uid !== uid) throw new DomainError('card_already_present', 'Önce mevcut kartı çekin.', 409);
      store.setDemoState({ cardUid: uid, present: true, removedAtMs: state.removed_at_ms, eligibleAtMs: state.eligible_at_ms, paymentLatched: state.present ? Boolean(state.payment_latched) : withinRemovalWindow, lastPaymentAtMs: state.last_payment_at_ms }, machine.id);
    } else if (action === 'hold') {
      if (!state.present || state.card_uid !== uid) throw new DomainError('card_not_present', 'Önce kartı yaklaştırmalısınız.', 409);
      store.setDemoState({ cardUid: uid, present: true, removedAtMs: state.removed_at_ms, eligibleAtMs: state.eligible_at_ms, paymentLatched: Boolean(state.payment_latched), lastPaymentAtMs: state.last_payment_at_ms }, machine.id);
    } else if (action === 'remove') {
      if (!state.present || state.card_uid !== uid) throw new DomainError('card_not_present', 'Bu kart simülatörde takılı değil.', 409);
      store.setDemoState({ cardUid: uid, present: false, removedAtMs: now, eligibleAtMs: now + machine.card_removed_ms, paymentLatched: true, lastPaymentAtMs: state.last_payment_at_ms }, machine.id);
    } else {
      throw new DomainError('invalid_simulator_action', 'Simülatör eylemi approach, hold veya remove olmalıdır.');
    }
    res.json({ ok: true, simulator: store.getDemoState(machine.id) });
  }));

  app.post('/api/demo/payment', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    const idempotencyKey = String(req.body.idempotencyKey || '').trim();
    const uid = normalizeUid(req.body.cardUid || 'DEMO-0001');
    const result = store.pay({ machineId: req.body.machineId || 'DEMO-MACHINE', cardUid: uid, idempotencyKey, actorUserId: req.user.id, simulator: true });
    res.status(result.duplicate ? 200 : result.approved ? 201 : 402).json({ ...result, balanceAfterTl: formatMoney(result.balanceAfterCents), duplicate: Boolean(result.duplicate) });
  }));

  app.post('/api/admin/demo/free-play', requireAuth, requireRole('admin'), handle(async (req, res) => {
    const result = store.demoFreePlay({ machineId: req.body.machineId, cardUid: req.body.cardUid, reason: req.body.reason, idempotencyKey: req.body.idempotencyKey, actorUserId: req.user.id });
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  app.post('/api/demo/pulse/:id/simulate', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    res.json({ ok: true, pulse: store.simulatePulse(req.params.id, req.body.outcome, req.user.id) });
  }));

  app.post('/api/demo/pulse/:id/retry', requireAuth, requireRole('admin', 'staff'), handle(async (req, res) => {
    res.json({ ok: true, pulse: store.retryPulse(req.params.id, req.user.id) });
  }));

  app.post('/api/demo/pulse/:id/review', requireAuth, requireRole('admin'), handle(async (req, res) => {
    const result = store.reviewPulse({ commandId: req.params.id, decision: req.body.decision, reason: req.body.reason, idempotencyKey: req.body.idempotencyKey, actorUserId: req.user.id });
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  app.get('/api/history', requireAuth, handle(async (req, res) => {
    const actorUserId = req.user.role === 'staff' ? req.user.id : null;
    res.json({ ok: true, ledger: store.listLedger({ actorUserId }), pulses: req.user.role === 'admin' ? store.listPulses() : [] });
  }));

  function detailFilters(query, exportAll = false) {
    const pageString = query.page ?? '1';
    if (typeof pageString !== 'string' || !/^[1-9]\d{0,5}$/.test(pageString)) throw new DomainError('invalid_page', 'Geçersiz sayfa.');
    return { from: query.from ?? '', to: query.to ?? '', machineId: query.machineId ?? '', type: query.type ?? '', page: Number(pageString), exportAll };
  }

  app.get('/api/admin/history/details', requireAuth, requireRole('admin'), handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...store.detailedLedger(detailFilters(req.query)) });
  }));

  app.get('/api/admin/history/details.csv', requireAuth, requireRole('admin'), handle(async (req, res) => {
    const data = store.detailedLedger(detailFilters(req.query, true));
    res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="opencredit-demo-hareketler.csv"', 'X-Content-Type-Options': 'nosniff' });
    res.type('text/csv; charset=utf-8').send(detailedCsv(data));
  }));

  app.get('/api/report', requireAuth, requireRole('admin'), handle(async (_req, res) => {
    const summary = store.summary();
    res.json({ ok: true, summary: { ...summary, topupsTl: formatMoney(summary.topups_cents), gameChargesTl: formatMoney(summary.game_charges_cents), correctionsTl: formatMoney(summary.corrections_cents), bonusesTl: formatMoney(summary.bonuses_cents), freePlayTl: formatMoney(summary.free_play_cents) } });
  }));

  app.get('/api/report/period', requireAuth, requireRole('admin'), handle(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, report: store.periodReport(req.query.period || 'day', new Date(), req.query.date) });
  }));

  app.get('/api/report/period.csv', requireAuth, requireRole('admin'), handle(async (req, res) => {
    const now = new Date();
    const report = store.periodReport(req.query.period || 'day', now, req.query.date);
    res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="opencredit-demo-rapor.csv"', 'X-Content-Type-Options': 'nosniff' });
    res.type('text/csv; charset=utf-8').send(reportCsv(report, now));
  }));

  app.get(mountPath, (_req, res) => res.render('phase1'));
  if (standalone) app.get('/', (_req, res) => res.redirect('/phase1'));
  return app;
}

function startServer({ host = process.env.PHASE1_HOST || DEFAULT_HOST, port = Number(process.env.PHASE1_PORT || DEFAULT_PORT), databasePath = process.env.PHASE1_DB_PATH || path.join(process.cwd(), 'phase1-data', 'demo.sqlite') } = {}) {
  const store = createStore(databasePath);
  const mountedApp = createApp({ store, standalone: false });
  const app = express();
  app.get('/', (_req, res) => res.redirect('/phase1'));
  app.use('/phase1', mountedApp);
  app.use('/', mountedApp);
  const server = app.listen(port, host, () => console.log(`mck_mifare Faz 1 demo: http://${host}:${port}/phase1`));
  return { app, server, store, close: () => new Promise((resolve, reject) => server.close((error) => { store.close(); error ? reject(error) : resolve(); })) };
}

// startServer is retained only as a test harness; production entry is card-server.js.
module.exports = { createApp, startServer, reportCsv };
