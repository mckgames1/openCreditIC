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
    demoMode: true, config: { arcade_name: 'openCreditIC Demo', show_delete_actions: false },
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
    const result = store.topUp({ accountId: req.body.accountId, cardUid: req.body.cardUid || null, amountCents, idempotencyKey: req.body.idempotencyKey, actorUserId: req.user.id });
    res.status(result.duplicate ? 200 : 201).json({ ...result, amountTl: formatMoney(result.amountCents), balanceAfterTl: formatMoney(result.balanceAfterCents) });
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

  app.get('/api/report', requireAuth, requireRole('admin'), handle(async (_req, res) => {
    const summary = store.summary();
    res.json({ ok: true, summary: { ...summary, topupsTl: formatMoney(summary.topups_cents), gameChargesTl: formatMoney(summary.game_charges_cents), correctionsTl: formatMoney(summary.corrections_cents), bonusesTl: formatMoney(summary.bonuses_cents), freePlayTl: formatMoney(summary.free_play_cents) } });
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
  const server = app.listen(port, host, () => console.log(`openCreditIC Faz 1 demo: http://${host}:${port}/phase1`));
  return { app, server, store, close: () => new Promise((resolve, reject) => server.close((error) => { store.close(); error ? reject(error) : resolve(); })) };
}

// startServer is retained only as a test harness; production entry is card-server.js.
module.exports = { createApp, startServer };
