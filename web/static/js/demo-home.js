'use strict';
(() => {
  let account;
  let card;
  let pendingKey;
  let registerKey;
  let machines = [];
  const notice = document.getElementById('demoNotice');
  const tell = message => { notice.textContent = message; };
  async function api(path, body, method = 'POST') {
    const response = await fetch('/phase1/api/' + path, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'İşlem başarısız.');
    return data;
  }
  async function refresh(selectedUid) {
    const data = await api('state');
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
    const isAdmin = data.user.role === 'admin';
    document.getElementById('demoAdmin').hidden = !isAdmin;
    if (isAdmin) {
      const tl = value => (Number(value) / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
      document.getElementById('demoTotals').textContent = `Yükleme: ${tl(data.summary.topups_cents)} · Harcama: ${tl(data.summary.game_charges_cents)} · Kalan bakiye: ${tl(data.accounts.reduce((sum, item) => sum + item.tl_balance_cents, 0))}`;
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
  document.getElementById('demoCardChoice').addEventListener('change', event => { pendingKey = null; refresh(event.target.value).catch(error => tell(error.message)); });
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
  window.depositCredits = async () => {
    if (!account || !card) return tell('Önce giriş yapın.');
    const button = document.querySelector('#depositModal .modal-footer .btn-primary');
    if (button.disabled) return;
    button.disabled = true;
    pendingKey ||= 'topup-' + crypto.randomUUID();
    try {
      const result = await api('topups', { accountId: account.id, cardUid: card.uid, amountTl: document.getElementById('depositBalance').value, idempotencyKey: pendingKey });
      pendingKey = null;
      await refresh();
      tell(`Demo yükleme tamamlandı. Bakiye ${result.balanceAfterTl} TL.`);
      window.$('#depositModal').modal('hide');
    } catch (error) { tell(error.message + ' Aynı isteği tekrar deneyebilirsiniz.'); }
    finally { button.disabled = false; }
  };
  document.getElementById('depositBalance').addEventListener('input', () => { pendingKey = null; });
  refresh().catch(() => {});
})();
