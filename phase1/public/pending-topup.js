'use strict';
// Shared by both local demo views. A separate key per request avoids overwriting
// another pending request; storage is not a substitute for a server-side queue.
(() => {
  const prefix = 'opencredit.pending.topup.v1.';
  const legacyKeys = ['opencreditPendingHomeTopup', 'opencreditPendingSimulatorTopup'];
  function parse(value) {
    const pending = JSON.parse(value);
    if (!pending || typeof pending.userId !== 'string' || !pending.body || typeof pending.body.idempotencyKey !== 'string' || !/^topup-[a-zA-Z0-9-]+$/.test(pending.body.idempotencyKey) || typeof pending.body.accountId !== 'string' || typeof pending.body.amountTl !== 'string') throw new Error('Bekleyen demo kaydı okunamadı; yeni yükleme başlatılmadı.');
    return pending;
  }
  function save(pending) {
    const normalized = parse(JSON.stringify(pending));
    const key = prefix + normalized.body.idempotencyKey;
    const previous = localStorage.getItem(key);
    if (previous !== null && previous !== JSON.stringify(normalized)) throw new Error('Bekleyen demo kayıtları çakışıyor; yeni yükleme başlatılmadı.');
    localStorage.setItem(key, JSON.stringify(normalized));
    if (localStorage.getItem(key) !== JSON.stringify(normalized)) throw new Error('Demo isteği kalıcı kaydedilemedi.');
  }
  function list() {
    for (const key of legacyKeys) {
      const value = sessionStorage.getItem(key);
      if (value !== null) save(parse(value)); // preserve old record until confirmed
    }
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const pending = parse(localStorage.getItem(key));
      if (key !== prefix + pending.body.idempotencyKey) throw new Error('Bekleyen demo kayıt anahtarı uyuşmuyor.');
      items.push(pending);
    }
    return items.sort((a, b) => a.body.idempotencyKey.localeCompare(b.body.idempotencyKey));
  }
  function clear(pending) {
    const key = prefix + pending.body.idempotencyKey;
    if (localStorage.getItem(key) !== JSON.stringify(pending)) throw new Error('Bekleyen kayıt değişti; kendiliğinden silinmedi.');
    for (const legacyKey of legacyKeys) {
      const value = sessionStorage.getItem(legacyKey);
      if (value !== null && parse(value).body.idempotencyKey === pending.body.idempotencyKey) sessionStorage.removeItem(legacyKey);
    }
    localStorage.removeItem(key);
  }
  function validAmount(amount) {
    const text = String(amount ?? '').trim().replace(',', '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return false;
    const [lira, kurus = ''] = text.split('.');
    const cents = Number(lira) * 100 + Number((kurus + '00').slice(0, 2));
    return Number.isSafeInteger(cents) && cents > 0 && cents <= 9000000000000000;
  }
  window.PendingDemoTopups = { list, save, clear, validAmount };
})();
