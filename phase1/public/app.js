'use strict';

const state = { data: null, lastPaymentKey: null, lastPaymentCard: null, lastPaymentMachine: null, lastPulseId: null };
const $ = (selector) => document.querySelector(selector);
const API_BASE = location.pathname === '/phase1' || location.pathname.startsWith('/phase1/') ? '/phase1' : '';

function showNotice(message, error = false) {
  const node = $('#notice');
  node.textContent = message;
  node.hidden = !message;
  node.classList.toggle('error', error);
}

async function api(url, options = {}) {
  const response = await fetch(`${API_BASE}${url}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({ ok: false, message: 'Sunucu yanıtı okunamadı.' }));
  if (!response.ok && ![402].includes(response.status)) {
    const error = new Error(data.message || 'İşlem başarısız.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function money(cents) { return `${(Number(cents || 0) / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`; }
function idempotency(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function selectedCard() { return $('#sim-card-select').value || 'DEMO-0001'; }
function selectedMachine() { return $('#sim-machine-select').value || 'DEMO-MACHINE'; }

function screen(mode, detail = '') {
  const messages = {
    waiting: 'KARTINIZI OKUTUN', processing: 'İŞLEM YAPILIYOR',
    ready: 'KART OKUNDU', held: 'KARTI ÇEKİN', success: 'ÖDEME ONAYLANDI',
    insufficient: 'YETERSİZ BAKİYE', invalid: 'GEÇERSİZ / ENGELLİ KART',
    offline: 'MERKEZ BAĞLANTISI YOK', error: 'İŞLEM TAMAMLANAMADI'
  };
  const label = $('#screen-state');
  label.replaceChildren();
  const title = document.createElement('div');
  title.textContent = messages[mode];
  label.append(title);
  if (detail) { const line = document.createElement('div'); line.className = 'screen-detail'; line.textContent = detail; label.append(line); }
  const color = mode === 'success' ? 'green' : ['insufficient', 'invalid', 'offline', 'error'].includes(mode) ? 'red' : 'off';
  $('#sim-led').className = `led ${color}`;
  const machine = state.data?.machines.find(item => item.id === selectedMachine());
  $('#sim-led').style.opacity = machine?.simulated_led_enabled ? String(machine.simulated_led_brightness / 255) : '0';
}

async function loadSetup() {
  const data = await api('/api/setup/status');
  $('#setup-card').hidden = !data.setupRequired;
  $('#login-card').hidden = data.setupRequired;
}

function fillSelect(select, items, getValue, getLabel) {
  const previous = select.value;
  select.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = getValue(item);
    option.textContent = getLabel(item);
    select.append(option);
  }
  if (items.some(item => String(getValue(item)) === previous)) select.value = previous;
}

function render(data) {
  state.data = data;
  $('#auth-panel').hidden = true;
  $('#app-panel').hidden = false;
  $('#user-label').textContent = data.user.username;
  $('#role-label').textContent = data.user.role === 'admin' ? 'YÖNETİCİ' : 'PERSONEL';
  const account = data.accounts[0];
  fillSelect($('#sim-machine-select'), data.machines, item => item.id, item => item.name);
  const machine = data.machines.find(item => item.id === selectedMachine()) || data.machines[0];
  const statusLabels = { pending: 'Bekliyor', applied: 'Testte uygulandı', failed: 'Test başarısız' };
  $('#sim-settings-status').textContent = machine ? `Sürüm ${machine.settings_version}, test LED raporu: ${statusLabels[machine.settings_status]}. Gerçek cihaz doğrulaması yok.` : '';
  $('#sim-settings-actions').hidden = data.user.role !== 'admin';
  $('#balance').textContent = money(account?.tl_balance_cents);
  $('#account-label').textContent = account ? `${account.name} · ${account.id}` : 'Hesap yok';
  $('#machine-price').textContent = money(machine?.price_cents);
  $('#machine-label').textContent = machine ? `${machine.name} · ${machine.pulse_ms} ms × ${machine.pulse_count}` : 'Makine yok';
  $('#ledger-count').textContent = data.summary ? `${data.summary.ledger_count} işlem` : `${data.ledger.length} kendi işleminiz`;
  $('#pulse-count').textContent = data.summary ? `${data.summary.pulseCount} pulse komutu` : '';
  fillSelect($('#account-select'), data.accounts, (item) => item.id, (item) => `${item.name} (${money(item.tl_balance_cents)})`);
  fillSelect($('#card-select'), data.cards, (item) => item.uid, (item) => `${item.uid} · ${item.account_name}`);
  fillSelect($('#sim-card-select'), data.cards, (item) => item.uid, (item) => item.uid);
  syncTopupCard();
  showPendingTopup();
  $('#admin-panel').hidden = data.user.role !== 'admin';
  $('#review-panel').hidden = data.user.role !== 'admin';
  if (data.user.role === 'admin') {
    const reviewed = new Set(data.reviews.map(item => item.command_id));
    const pendingReview = JSON.parse(sessionStorage.getItem('demoPendingReview') || 'null');
    fillSelect($('#review-command'), data.pulses.filter(item => item.status === 'ambiguous' && (!reviewed.has(item.id) || item.id === pendingReview?.commandId)), item => item.id, item => `${item.id} · ${item.last_outcome}`);
    if (pendingReview) {
      $('#review-command').value = pendingReview.commandId;
      $('#review-decision').value = pendingReview.decision;
      $('#review-reason').value = pendingReview.reason;
    }
    const list = $('#review-list');
    list.replaceChildren();
    for (const review of data.reviews) {
      const item = document.createElement('li');
      item.textContent = `${review.command_id} · ${review.decision} · ${review.actor_username} · ${review.created_at} · ${review.reason}`;
      list.append(item);
    }
  }
  if (machine) {
    $('#machine-form [name="priceTl"]').value = (Number(machine.price_cents) / 100).toFixed(2).replace('.', ',');
    $('#machine-form [name="pulseMs"]').value = machine.pulse_ms;
    $('#machine-form [name="pulseCount"]').value = machine.pulse_count;
    $('#machine-form [name="pulseGapMs"]').value = machine.pulse_gap_ms;
  }
  renderSimulator(data.simulator);
  renderHistory(data.ledger, data.pulses);
}

function syncTopupCard() {
  if (!state.data) return;
  const card = state.data.cards.find(item => item.uid === $('#card-select').value);
  if (card) $('#account-select').value = card.account_id;
}

$('#card-select').addEventListener('change', syncTopupCard);
$('#account-select').addEventListener('change', () => {
  const card = state.data?.cards.find(item => item.account_id === $('#account-select').value);
  if (card) $('#card-select').value = card.uid;
});

function pendingTopup() { return PendingDemoTopups.list()[0] || null; }
function showPendingTopup() {
  try {
    const pending = pendingTopup();
    $('#sim-topup-pending').hidden = !pending;
    $('#sim-topup-retry').hidden = !pending;
    if (pending) $('#sim-topup-pending').textContent = state.data?.user?.id === pending.userId
      ? `Sonucu bilinmeyen yükleme: ${pending.body.cardUid} · ${pending.body.amountTl} TL · İstek kimliği: ${pending.body.idempotencyKey}. Aynı kullanıcıyla doğrulayın; yeni yükleme başlatılamaz.`
      : 'Bu tarayıcıda başka bir kullanıcının bekleyen yüklemesi var; işlemi başlatan kullanıcıyla doğrulayın.';
  } catch (_) { $('#sim-topup-pending').hidden = false; $('#sim-topup-retry').hidden = true; $('#sim-topup-pending').textContent = 'Bekleyen kaydı okunamıyor; yeni yükleme başlatılmadı. Tarayıcı verisini silmeyin ve durumu inceleyin.'; }
}

async function sendPendingTopup() {
  let pending;
  try { pending = pendingTopup(); } catch (_) { showPendingTopup(); return; }
  if (!pending) return;
  if (!state.data?.user || state.data.user.id !== pending.userId) return showNotice('Bekleyen yüklemeyi başlatan kullanıcıyla giriş yapın.', true);
  const submit = $('#topup-form button[type="submit"]');
  const retry = $('#sim-topup-retry');
  if (submit.disabled || retry.disabled) return;
  submit.disabled = true;
  retry.disabled = true;
  try {
    await api('/api/demo/topup-intents', { method: 'POST', body: JSON.stringify(pending.body) });
    const data = await api('/api/demo/topup-intents/execute', { method: 'POST', body: JSON.stringify({ intentId: pending.body.idempotencyKey }) });
    PendingDemoTopups.clear(pending);
    showPendingTopup();
    showNotice(`${data.duplicate ? 'Önceki yükleme doğrulandı' : 'Yükleme tamamlandı'}: ${data.amountTl} TL; bakiye ${data.balanceAfterTl} TL.`);
    await refresh();
  } catch (error) {
    showNotice(`${error.message} Kayıt korunuyor; sonuç belirsizse inceleyin ve aynı istekle doğrulayın.`, true);
  } finally { submit.disabled = false; retry.disabled = false; }
}

function renderSimulator(simulator) {
  if ($('#sim-connection').value === 'offline') { screen('offline'); return; }
  const present = Boolean(simulator.present);
  const latched = Boolean(simulator.payment_latched);
  const machine = state.data?.machines.find(item => item.id === selectedMachine());
  screen(latched ? 'held' : present ? 'ready' : 'waiting', !present && machine ? `Oyun: ${money(machine.price_cents)}` : '');
  $('#sim-message').textContent = latched ? 'Yeni ödeme için kartı çekip bekleyin.' : present ? 'Kart simülatörde tutuluyor.' : 'Kartı yaklaştırıp tutun.';
}

function renderHistory(ledger, pulses) {
  const rows = [];
  for (const entry of ledger || []) rows.push({ time: entry.created_at, type: entry.entry_type, amount: money(entry.amount_cents), balance: money(entry.balance_after_cents), status: entry.id });
  for (const pulse of pulses || []) rows.push({ time: pulse.created_at, type: 'pulse_command', amount: money(pulse.amount_cents), balance: '—', status: `${pulse.status} · ${pulse.id}` });
  rows.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  $('#history-body').innerHTML = rows.slice(0, 30).map((row) => `<tr><td>${new Date(row.time).toLocaleString('tr-TR')}</td><td>${row.type}</td><td>${row.amount}</td><td>${row.balance}</td><td>${row.status}</td></tr>`).join('') || '<tr><td colspan="5">Henüz hareket yok.</td></tr>';
}

async function refresh() {
  try { render(await api(`/api/state?machineId=${encodeURIComponent(selectedMachine())}`)); } catch (error) { showNotice(error.message, true); }
}

async function runAction(action, cardUid = selectedCard()) {
  if ($('#sim-connection').value === 'offline') {
    screen('offline');
    showNotice('Merkez bağlantısı kesik: kart isteği gönderilmedi.', true);
    return;
  }
  try {
    const data = await api('/api/demo/simulator/card', { method: 'POST', body: JSON.stringify({ action, cardUid, machineId: selectedMachine() }) });
    renderSimulator(data.simulator);
    showNotice(action === 'remove' ? 'Kart çekildi; bekleme süresi başladı.' : 'Simülatör güncellendi.');
    if (action === 'remove') setTimeout(refresh, 1100);
  } catch (error) { showNotice(error.message, true); }
}

$('#setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    await api('/api/setup', { method: 'POST', body: JSON.stringify(body) });
    showNotice('Yönetici oluşturuldu.');
    await refresh();
  } catch (error) { showNotice(error.message, true); }
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
    showNotice('Giriş başarılı.');
    await refresh();
  } catch (error) { showNotice(error.message, true); }
});

$('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); });
$('#refresh').addEventListener('click', refresh);
$('#sim-machine-select').addEventListener('change', refresh);
async function simulatedSettingsResult(status) {
  const machine = state.data?.machines.find(item => item.id === selectedMachine());
  if (!machine) return;
  const buttons = [$('#sim-settings-apply'), $('#sim-settings-fail')];
  if (buttons.some(button => button.disabled)) return;
  buttons.forEach(button => { button.disabled = true; });
  try {
    await api(`/api/demo/machines/${encodeURIComponent(machine.id)}/settings-result`, { method: 'POST', body: JSON.stringify({ version: machine.settings_version, status }) });
    await refresh();
    showNotice('Test sonucu kaydedildi; gerçek cihaza aktarılmadı.');
  } catch (error) { showNotice(error.message, true); await refresh(); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
$('#sim-settings-apply').addEventListener('click', () => simulatedSettingsResult('applied'));
$('#sim-settings-fail').addEventListener('click', () => simulatedSettingsResult('failed'));
$('#sim-connection').addEventListener('change', () => {
  if ($('#sim-connection').value === 'offline') screen('offline');
  else if (state.data) renderSimulator(state.data.simulator);
});
$('#approach').addEventListener('click', () => runAction('approach'));
$('#hold').addEventListener('click', () => runAction('hold'));
$('#remove').addEventListener('click', () => runAction('remove'));

$('#topup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.data?.user) return showNotice('Önce giriş yapın.', true);
  try { if (pendingTopup()) return showNotice('Önce bekleyen yüklemeyi doğrulayın.', true); }
  catch (_) { showPendingTopup(); return; }
  const body = Object.fromEntries(new FormData(event.currentTarget));
  if (!PendingDemoTopups.validAmount(body.amountTl)) return showNotice('Geçerli pozitif tutarı girin (en fazla iki ondalık).', true);
  body.idempotencyKey = idempotency('topup');
  try { PendingDemoTopups.save({ userId: state.data.user.id, body }); }
  catch (_) { return showNotice('isteği tarayıcıya kaydedilemedi; yükleme gönderilmedi.', true); }
  showPendingTopup();
  await sendPendingTopup();
});
$('#sim-topup-retry').addEventListener('click', sendPendingTopup);
window.addEventListener('storage', showPendingTopup);

async function sendPayment(key, cardOverride, machineOverride) {
  if ($('#sim-connection').value === 'offline') {
    screen('offline');
    showNotice('Merkez bağlantısı kesik: ödeme isteği gönderilmedi.', true);
    return;
  }
  let pending = JSON.parse(sessionStorage.getItem('demoPendingPayment') || 'null');
  if (!key && pending) { key = pending.key; }
  const cardUid = pending && pending.key === key ? pending.cardUid : (cardOverride || selectedCard());
  const machineId = pending && pending.key === key ? (pending.machineId || 'DEMO-MACHINE') : (machineOverride || selectedMachine());
  key ||= idempotency('payment');
  sessionStorage.setItem('demoPendingPayment', JSON.stringify({ key, cardUid, machineId }));
  $('#pay').disabled = true;
  screen('processing');
  try {
    const data = await api('/api/demo/payment', { method: 'POST', body: JSON.stringify({ machineId, cardUid, idempotencyKey: key }) });
    if (!data.approved) {
      sessionStorage.removeItem('demoPendingPayment');
      showNotice(`Ödeme reddedildi: yetersiz bakiye. Kalan: ${data.balanceAfterTl}.`, true);
      await refresh();
      screen('insufficient', `Bakiye: ${money(data.balanceAfterCents)}`);
      return;
    }
    state.lastPaymentKey = key;
    state.lastPaymentCard = cardUid;
    state.lastPaymentMachine = machineId;
    sessionStorage.removeItem('demoPendingPayment');
    state.lastPulseId = data.pulseCommandId || state.lastPulseId;
    $('#repeat-pay').disabled = false;
    if (data.pulseCommandId) { $('#pulse-info').textContent = `Komut: ${data.pulseCommandId} · ${data.priceTl || money(data.priceCents)} · pending`; $('#retry-pulse').disabled = false; }
    showNotice(data.duplicate ? 'Aynı istek tekrarlandı; ikinci düşüm veya pulse oluşturulmadı.' : `Ödeme onaylandı. Kalan: ${data.balanceAfterTl}.`);
    await refresh();
    screen('success', `Düşülen: ${money(data.priceCents)} · Kalan: ${money(data.balanceAfterCents)}`);
  } catch (error) {
    if (error.status >= 400 && error.status < 500) sessionStorage.removeItem('demoPendingPayment');
    showNotice(error.status >= 400 && error.status < 500 ? error.message : `${error.message} Aynı ödeme isteğini tekrar deneyin.`, true);
    screen(!error.status ? 'offline' : error.status === 403 || error.status === 404 ? 'invalid' : error.status === 409 ? 'held' : 'error');
  }
  finally { $('#pay').disabled = false; }
}

$('#pay').addEventListener('click', () => sendPayment());
$('#repeat-pay').addEventListener('click', () => { if (state.lastPaymentKey) sendPayment(state.lastPaymentKey, state.lastPaymentCard, state.lastPaymentMachine); });

document.querySelectorAll('.outcome').forEach((button) => button.addEventListener('click', async () => {
  if (!state.lastPulseId) return showNotice('Önce bir ödeme komutu oluşturun.', true);
  try { const data = await api(`/api/demo/pulse/${state.lastPulseId}/simulate`, { method: 'POST', body: JSON.stringify({ outcome: button.dataset.outcome }) }); showNotice(`Pulse sonucu: ${data.pulse.status}.`); await refresh(); } catch (error) { showNotice(error.message, true); }
}));

$('#retry-pulse').addEventListener('click', async () => {
  if (!state.lastPulseId) return;
  try { await api(`/api/demo/pulse/${state.lastPulseId}/retry`, { method: 'POST', body: '{}' }); showNotice('Aynı bekleyen komut kullanıldı; yeni ödeme oluşturulmadı.'); await refresh(); } catch (error) { showNotice(error.message, true); }
});

$('#review-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  if (button.disabled) return;
  let pending = JSON.parse(sessionStorage.getItem('demoPendingReview') || 'null');
  if (!pending) {
    pending = { commandId: $('#review-command').value, decision: $('#review-decision').value, reason: $('#review-reason').value, idempotencyKey: idempotency('review') };
    if (!pending.commandId) return showNotice('Önce belirsiz bir komut seçin.', true);
    sessionStorage.setItem('demoPendingReview', JSON.stringify(pending));
  }
  button.disabled = true;
  try {
    await api(`/api/demo/pulse/${encodeURIComponent(pending.commandId)}/review`, { method: 'POST', body: JSON.stringify(pending) });
    sessionStorage.removeItem('demoPendingReview');
    $('#review-reason').value = '';
    showNotice('İnceleme kaydedildi; bakiye ve komut değiştirilmedi.');
    await refresh();
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403) sessionStorage.removeItem('demoPendingReview');
    showNotice(`${error.message} Yanıt kaybında aynı incelemeyi yeniden gönderebilirsiniz.`, true);
  } finally { button.disabled = false; }
});

$('#machine-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    await api(`/api/machines/${encodeURIComponent(selectedMachine())}`, { method: 'PATCH', body: JSON.stringify(body) });
    showNotice('Makine ayarları kaydedildi. Yeni işlemler güncel fiyatı kullanır.');
    await refresh();
  } catch (error) { showNotice(error.message, true); }
});

async function lockCard(locked) {
  try { await api(`/api/cards/${encodeURIComponent(selectedCard())}/lock`, { method: 'POST', body: JSON.stringify({ locked }) }); showNotice(locked ? 'Kart kilitlendi.' : 'Kart kilidi açıldı.'); await refresh(); } catch (error) { showNotice(error.message, true); }
}
$('#lock-card').addEventListener('click', () => lockCard(true));
$('#unlock-card').addEventListener('click', () => lockCard(false));

loadSetup().catch((error) => showNotice(error.message, true));
