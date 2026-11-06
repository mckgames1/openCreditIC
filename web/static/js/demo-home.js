'use strict';
(() => {
  let account;
  let card;
  let currentUser;
  let registerKey;
  let machines = [];
  const notice = document.getElementById('demoNotice');
  const tell = message => { notice.textContent = message; };
  async function api(path, body, method = 'POST') {
    const response = await fetch('/phase1/api/' + path, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.message || 'İşlem başarısız.'); error.status = response.status; error.code = data.error; throw error; }
    return data;
  }
  async function refresh(selectedUid) {
    const data = await api('state');
    currentUser = data.user;
    const select = document.getElementById('demoCardChoice');
    const wanted = selectedUid || select.value || 'DEMO-0001';
    select.replaceChildren();
    for (const item of data.cards) {
      const option = document.createElement('option');
      option.value = item.uid;
      option.textContent = `${item.uid} · ${item.account_name}`;
      select.append(option);
    }
    select.value = wanted;
    card = data.cards.find(item => item.uid === select.value) || data.cards[0];
    account = data.accounts.find(item => item.id === card?.account_id);
    if (!account) throw new Error('Demo kartı bulunamadı.');
    document.getElementById('demoAccount').textContent = `${account.name} · Sanal kart ${card.uid} · Bakiye ${(account.tl_balance_cents / 100).toFixed(2)} TL`;
    showPending();
    const isAdmin = data.user.role === 'admin';
    document.getElementById('demoHistory').hidden = false;
    document.getElementById('demoHistoryScope').textContent = isAdmin ? 'Son 25 demo hareketi' : 'Son 25 kendi demo hareketiniz';
    const history = document.getElementById('demoHistoryRows');
    history.replaceChildren();
    for (const entry of data.ledger) {
      const row = document.createElement('tr');
      let type = { topup: 'Yükleme', game_charge: 'Oyun harcaması', correction: 'Düzeltme' }[entry.entry_type] || entry.entry_type;
      if (isAdmin && entry.entry_type === 'correction' && entry.note) type += ` — ${entry.note}`;
      for (const value of [entry.created_at, type, (entry.amount_cents / 100).toFixed(2) + ' TL', (entry.balance_after_cents / 100).toFixed(2) + ' TL', entry.id]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      history.append(row);
    }
    document.getElementById('demoAdmin').hidden = !isAdmin;
    if (isAdmin) {
      document.getElementById('demoCardStatus').textContent = `${card.uid}: ${card.locked ? 'Engelli' : 'Aktif'}`;
      document.getElementById('demoCardLock').textContent = card.locked ? 'Kart engelini kaldır' : 'Kartı engelle';
      const tl = value => (Number(value) / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
      document.getElementById('demoTotals').textContent = `Yükleme: ${tl(data.summary.topups_cents)} · Harcama: ${tl(data.summary.game_charges_cents)} · Net düzeltme: ${tl(data.summary.corrections_cents)} · Kalan bakiye: ${tl(data.accounts.reduce((sum, item) => sum + item.tl_balance_cents, 0))}`;
      showPendingCorrection();
      const machineSelect = document.getElementById('demoMachine');
      const prior = machineSelect.value;
      machines = data.machines;
      machineSelect.replaceChildren();
      for (const machine of machines) {
        const option = document.createElement('option');
        option.value = machine.id;
        option.textContent = `${machine.name} (${machine.id})`;
        machineSelect.append(option);
      }
      if (machines.some(machine => machine.id === prior)) machineSelect.value = prior;
      showMachine();
    }
  }
  function showMachine() {
    const machine = machines.find(item => item.id === document.getElementById('demoMachine').value);
    if (!machine) return;
    document.getElementById('demoMachineName').value = machine.name;
    document.getElementById('demoPrice').value = (machine.price_cents / 100).toFixed(2);
    document.getElementById('demoPulseMs').value = machine.pulse_ms;
    document.getElementById('demoPulseCount').value = machine.pulse_count;
    document.getElementById('demoPulseGap').value = machine.pulse_gap_ms;
    document.getElementById('demoMachineEnabled').checked = machine.enabled;
  }
  document.getElementById('demoMachine').addEventListener('change', showMachine);
  document.getElementById('demoCardLock').addEventListener('click', async event => {
    if (!card || !currentUser || currentUser.role !== 'admin') return tell('Yönetici girişi gerekli.');
    const button = event.currentTarget;
    const uid = card.uid;
    const locked = !card.locked;
    button.disabled = true;
    document.getElementById('demoCardChoice').disabled = true;
    try {
      await api('cards/' + encodeURIComponent(uid) + '/lock', { locked });
      await refresh(uid);
      tell(locked ? 'Demo kart engellendi.' : 'Demo kart engeli kaldırıldı.');
    } catch (error) { tell(error.message + ' Durumu yenileyip kontrol edin.'); }
    finally { button.disabled = false; document.getElementById('demoCardChoice').disabled = false; }
  });
  const correctionKey = 'opencreditPendingCorrection';
  function showPendingCorrection() {
    const pending = JSON.parse(sessionStorage.getItem(correctionKey) || 'null');
    const message = document.getElementById('demoCorrectionPending');
    const retry = document.getElementById('demoCorrectionRetry');
    message.hidden = !pending;
    retry.hidden = !pending;
    if (pending) message.textContent = `Sonucu bilinmeyen düzeltme: ${pending.body.accountId} · ${pending.body.direction === 'add' ? '+' : '-'}${pending.body.amountTl} TL. Aynı yönetici ile doğrulayın.`;
  }
  async function sendCorrection() {
    const pending = JSON.parse(sessionStorage.getItem(correctionKey) || 'null');
    if (!pending) return;
    if (!currentUser || currentUser.id !== pending.userId) return tell('Düzeltmeyi başlatan yöneticiyle giriş yapın.');
    const button = document.querySelector('#demoCorrectionForm button');
    const retry = document.getElementById('demoCorrectionRetry');
    if (button.disabled || retry.disabled) return;
    button.disabled = true;
    retry.disabled = true;
    try {
      const result = await api('admin/corrections', pending.body);
      sessionStorage.removeItem(correctionKey);
      showPendingCorrection();
      document.getElementById('demoCorrectionForm').reset();
      await refresh();
      tell(`Demo düzeltme ${result.duplicate ? 'doğrulandı' : 'kaydedildi'}: ${result.entryId}.`);
    } catch (error) {
      if (error.status === 400 || error.status === 404 || error.code === 'invalid_balance') { sessionStorage.removeItem(correctionKey); showPendingCorrection(); }
      tell(error.message);
    } finally { button.disabled = false; retry.disabled = false; }
  }
  document.getElementById('demoCorrectionForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!account || !currentUser) return tell('Önce giriş yapın.');
    if (sessionStorage.getItem(correctionKey)) return tell('Önce bekleyen düzeltmeyi doğrulayın.');
    sessionStorage.setItem(correctionKey, JSON.stringify({ userId: currentUser.id, body: {
      accountId: account.id, direction: document.getElementById('demoCorrectionDirection').value,
      amountTl: document.getElementById('demoCorrectionAmount').value,
      reason: document.getElementById('demoCorrectionReason').value, idempotencyKey: 'correction-' + crypto.randomUUID()
    } }));
    showPendingCorrection();
    await sendCorrection();
  });
  document.getElementById('demoCorrectionRetry').addEventListener('click', sendCorrection);
  document.getElementById('demoStaffForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const result = await api('admin/users', {
        username: document.getElementById('demoStaffUsername').value,
        password: document.getElementById('demoStaffPassword').value,
        role: 'staff'
      });
      form.reset();
      tell(`Demo personel hesabı oluşturuldu: ${result.user.username}.`);
    } catch (error) { tell(error.message); }
    finally { button.disabled = false; }
  });
  document.getElementById('demoMachineForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const id = document.getElementById('demoMachine').value;
      await api('machines/' + encodeURIComponent(id), {
        name: document.getElementById('demoMachineName').value,
        priceTl: document.getElementById('demoPrice').value,
        pulseMs: document.getElementById('demoPulseMs').value,
        pulseCount: document.getElementById('demoPulseCount').value,
        pulseGapMs: document.getElementById('demoPulseGap').value,
        enabled: document.getElementById('demoMachineEnabled').checked
      }, 'PATCH');
      await refresh();
      tell('Demo makine ayarları kaydedildi.');
    } catch (error) { tell(error.message); }
    finally { button.disabled = false; }
  });
  document.getElementById('demoCardChoice').addEventListener('change', async event => {
    const select = event.currentTarget;
    const correctionButton = document.querySelector('#demoCorrectionForm button');
    const lockButton = document.getElementById('demoCardLock');
    const depositButton = document.querySelector('#depositModal .modal-footer .btn-primary');
    select.disabled = true;
    correctionButton.disabled = true;
    lockButton.disabled = true;
    depositButton.disabled = true;
    try { await refresh(select.value); }
    catch (error) { account = null; card = null; tell(error.message); }
    finally { select.disabled = false; correctionButton.disabled = false; lockButton.disabled = false; depositButton.disabled = false; }
  });
  window.registerUser = async () => {
    const button = document.querySelector('#newCardModal .modal-footer .btn-primary');
    if (button.disabled) return;
    button.disabled = true;
    registerKey ||= 'registration-' + crypto.randomUUID();
    try {
      const result = await api('demo/register', { name: document.getElementById('userName').value, uid: document.getElementById('cardNum').value, idempotencyKey: registerKey });
      registerKey = null;
      await refresh(result.card.uid);
      tell('Demo hesap ve sanal kart oluşturuldu.');
      window.$('#newCardModal').modal('hide');
    } catch (error) { tell(error.message + ' Aynı isteği tekrar deneyebilirsiniz.'); }
    finally { button.disabled = false; }
  };
  for (const id of ['userName', 'cardNum']) document.getElementById(id).addEventListener('input', () => { registerKey = null; });
  document.getElementById('demoLogin').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const status = await api('setup/status');
      await api(status.setupRequired ? 'setup' : 'auth/login', { username: document.getElementById('demoUsername').value, password: document.getElementById('demoPassword').value });
      document.getElementById('demoPassword').value = '';
      await refresh();
      tell('Giriş yapıldı. Yükleme düğmesiyle demo bakiye ekleyebilirsiniz.');
    } catch (error) { tell(error.message); }
  });
  const pendingStorageKey = 'opencreditPendingHomeTopup';
  function getPending() { return JSON.parse(sessionStorage.getItem(pendingStorageKey) || 'null'); }
  function showPending() {
    const pending = getPending();
    const message = document.getElementById('demoPendingNotice');
    const retry = document.getElementById('demoRetryTopup');
    message.hidden = !pending;
    retry.hidden = !pending;
    if (pending) message.textContent = `Sonucu bilinmeyen demo yükleme: ${pending.body.cardUid} · ${pending.body.amountTl} TL. Aynı kullanıcıyla doğrulayın; yeni yükleme başlatılamaz.`;
  }
  async function sendPendingTopup() {
    const pending = getPending();
    if (!pending) return;
    if (!currentUser || currentUser.id !== pending.userId) return tell('Bekleyen yüklemeyi başlatan kullanıcıyla giriş yapın.');
    const button = document.querySelector('#depositModal .modal-footer .btn-primary');
    const retry = document.getElementById('demoRetryTopup');
    if (button.disabled || retry.disabled) return;
    button.disabled = true;
    retry.disabled = true;
    try {
      const result = await api('topups', pending.body);
      sessionStorage.removeItem(pendingStorageKey);
      showPending();
      await refresh(pending.body.cardUid);
      tell(`${result.duplicate ? 'Önceki yükleme doğrulandı' : 'Demo yükleme tamamlandı'}. İşlem ${result.entryId}; bakiye ${result.balanceAfterTl} TL.`);
      window.$('#depositModal').modal('hide');
    } catch (error) {
      if (error.status === 400 || error.status === 404) { sessionStorage.removeItem(pendingStorageKey); showPending(); }
      tell(error.message + ' Bekleyen işlemi aynı içerikle doğrulayın.');
    } finally { button.disabled = false; retry.disabled = false; }
  }
  window.depositCredits = async () => {
    if (!account || !card || !currentUser) return tell('Önce giriş yapın.');
    if (getPending()) return tell('Önce bekleyen yüklemeyi doğrulayın.');
    const pending = { userId: currentUser.id, body: { accountId: account.id, cardUid: card.uid, amountTl: document.getElementById('depositBalance').value, idempotencyKey: 'topup-' + crypto.randomUUID() } };
    sessionStorage.setItem(pendingStorageKey, JSON.stringify(pending));
    showPending();
    await sendPendingTopup();
  };
  document.getElementById('demoRetryTopup').addEventListener('click', sendPendingTopup);
  refresh().catch(() => {});
})();
