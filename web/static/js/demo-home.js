'use strict';
(() => {
  let account;
  let card;
  let pendingKey;
  const notice = document.getElementById('demoNotice');
  const tell = message => { notice.textContent = message; };
  async function api(path, body) {
    const response = await fetch('/phase1/api/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'İşlem başarısız.');
    return data;
  }
  async function refresh() {
    const data = await api('state');
    card = data.cards.find(item => item.uid === 'DEMO-0001');
    account = data.accounts.find(item => item.id === card?.account_id);
    if (!account) throw new Error('Demo kartı bulunamadı.');
    document.getElementById('demoAccount').textContent = `${account.name} · Sanal kart ${card.uid} · Bakiye ${(account.tl_balance_cents / 100).toFixed(2)} TL`;
  }
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
