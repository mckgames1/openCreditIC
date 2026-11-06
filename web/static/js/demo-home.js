'use strict';
(() => {
  let account;
  let card;
  let currentUser;
  let registerKey;
  let machines = [];
  let reportRequest = 0;
  let detailRequest = 0;
  let topupHistoryRequest = 0;
  let intentRequest = 0;
  let detailPage = 1;
  let turnoverAmount = '';
  let turnoverHidden = false;
  const turnoverBox = document.getElementById('turnoverBox');
  const turnoverValue = document.getElementById('turnoverValue');
  const turnoverToggle = document.getElementById('turnoverToggle');
  function showTurnover() {
    turnoverValue.textContent = turnoverHidden ? '***' : turnoverAmount;
    turnoverToggle.textContent = turnoverHidden ? 'Göster' : 'Gizle';
    turnoverToggle.setAttribute('aria-pressed', String(turnoverHidden));
  }
  turnoverToggle.addEventListener('click', () => { turnoverHidden = !turnoverHidden; showTurnover(); });
  const notice = document.getElementById('demoNotice');
  const tell = message => { notice.textContent = message; };
  async function api(path, body, method = 'POST') {
    const response = await fetch('/phase1/api/' + path, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.message || 'İşlem başarısız.'); error.status = response.status; error.code = data.error; throw error; }
    return data;
  }
  async function refresh(selectedUid) {
    ++topupHistoryRequest;
    ++intentRequest;
    document.getElementById('demoRecordedTopupsRows').replaceChildren();
    document.getElementById('demoRecordedTopupsStatus').textContent = '';
    document.getElementById('demoRecordedTopups').hidden = true;
    document.getElementById('demoOpenIntentsRows').replaceChildren();
    document.getElementById('demoOpenIntentsStatus').textContent = '';
    document.getElementById('demoOpenIntents').hidden = true;
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
    if (!account) throw new Error('Kart bulunamadı.');
    document.getElementById('demoAccount').textContent = `${account.name}${account.phone ? ' · Telefon ' + account.phone : ''} · Kart ${card.uid} · Bakiye ${(account.tl_balance_cents / 100).toFixed(2)} TL`;
    showPending();
    showPendingCardLink();
    const isAdmin = data.user.role === 'admin';
    turnoverBox.hidden = !isAdmin;
    if (!isAdmin) { turnoverAmount = ''; turnoverValue.textContent = ''; }
    if (!isAdmin) {
      reportRequest++;
      detailRequest++;
      for (const id of ['demoResetIssueResult', 'demoReportTotals', 'demoReportCommands', 'demoReportChart', 'demoReportMachines', 'demoPulseRows', 'demoDetailRows', 'demoDetailStatus', 'demoTopupLookupResult']) document.getElementById(id).replaceChildren();
      document.getElementById('demoTopupLookupKey').value = '';
      document.getElementById('demoFreePlayForm').reset();
      document.getElementById('demoFreePlayPending').textContent = '';
      document.getElementById('demoFreePlayPending').hidden = true;
      document.getElementById('demoFreePlayRetry').hidden = true;
    }
    document.getElementById('demoHistory').hidden = false;
    await refreshRecordedTopups();
    await refreshOpenIntents();
    document.getElementById('demoHistoryScope').textContent = isAdmin ? 'Son 25 hareket' : 'Son 25 kendi hareketiniz';
    const history = document.getElementById('demoHistoryRows');
    history.replaceChildren();
    for (const entry of data.ledger) {
      const row = document.createElement('tr');
      let type = { topup: 'Yükleme', game_charge: 'Oyun harcaması', correction: 'Düzeltme', free_play: 'Ücretsiz oyun' }[entry.entry_type] || entry.entry_type;
      if (isAdmin && ['correction', 'free_play'].includes(entry.entry_type) && entry.note) type += ` — ${entry.note}`;
      for (const value of [entry.created_at, type, (entry.amount_cents / 100).toFixed(2) + ' TL', (entry.balance_after_cents / 100).toFixed(2) + ' TL', entry.id]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      history.append(row);
    }
    document.getElementById('demoAdmin').hidden = !isAdmin;
    if (isAdmin) {
      const pulseRows = document.getElementById('demoPulseRows');
      pulseRows.replaceChildren();
      const labels = { pending: 'Bekliyor', succeeded: 'Testte başarılı', ambiguous: 'Belirsiz — inceleme gerekli', failed: 'Testte başarısız' };
      for (const pulse of data.pulses) {
        const row = document.createElement('tr');
        for (const value of [pulse.created_at, pulse.machine_id, (pulse.amount_cents / 100).toFixed(2) + ' TL', labels[pulse.status] || 'Bilinmeyen durum', pulse.id]) {
          const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
        }
        pulseRows.append(row);
      }
      const staffList = document.getElementById('demoStaffList');
      staffList.replaceChildren();
      const resetSelect = document.getElementById('demoResetStaff');
      const previousStaff = resetSelect.value;
      resetSelect.replaceChildren();
      for (const user of data.staff) {
        if (!user.locked) {
          const option = document.createElement('option');
          option.value = user.id;
          option.textContent = user.username;
          resetSelect.append(option);
        }
        const row = document.createElement('li');
        row.className = 'mb-2';
        const label = document.createElement('span');
        label.textContent = `${user.username} — ${user.locked ? 'Erişimi durduruldu' : 'Aktif'} `;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-sm btn-outline-secondary';
        button.textContent = user.locked ? 'Erişimi aç' : 'Erişimi durdur';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api('admin/staff/' + encodeURIComponent(user.id) + '/lock', { locked: !user.locked });
            await refresh();
            tell(`Personel hesabı ${user.locked ? 'açıldı' : 'durduruldu'}: ${user.username}.`);
          } catch (error) { tell(error.message + ' Durumu yenileyip kontrol edin.'); }
          finally { button.disabled = false; }
        });
        row.append(label, button);
        staffList.append(row);
      }
      if ([...resetSelect.options].some(option => option.value === previousStaff)) resetSelect.value = previousStaff;
      document.getElementById('demoCardStatus').textContent = `${card.uid}: ${card.locked ? 'Engelli' : 'Aktif'}`;
      document.getElementById('demoCardLock').textContent = card.locked ? 'Kart engelini kaldır' : 'Kartı engelle';
      const tl = value => (Number(value) / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
      turnoverAmount = tl(data.summary.topups_cents); showTurnover();
      document.getElementById('demoTotals').textContent = `Yükleme: ${tl(data.summary.topups_cents)} · Harcama: ${tl(data.summary.game_charges_cents)} · Net düzeltme: ${tl(data.summary.corrections_cents)} · Ücretsiz oyun: ${data.summary.free_plays_count} adet · Kalan bakiye: ${tl(data.accounts.reduce((sum, item) => sum + item.tl_balance_cents, 0))}`;
      showPendingFreePlay();
      await refreshReport();
      showPendingCorrection();
      const machineSelect = document.getElementById('demoMachine');
      const prior = machineSelect.value;
      machines = data.machines;
      machineSelect.replaceChildren();
      const detailMachine = document.getElementById('demoDetailMachine');
      const priorDetailMachine = detailMachine.value;
      detailMachine.replaceChildren();
      const allMachines = document.createElement('option'); allMachines.value = ''; allMachines.textContent = 'Tüm cihazlar'; detailMachine.append(allMachines);
      for (const machine of machines) {
        const option = document.createElement('option');
        option.value = machine.id;
        option.textContent = `${machine.name} (${machine.id})`;
        machineSelect.append(option);
        const detailOption = document.createElement('option'); detailOption.value = machine.id; detailOption.textContent = `${machine.name} (${machine.id})`; detailMachine.append(detailOption);
      }
      if (machines.some(machine => machine.id === priorDetailMachine)) detailMachine.value = priorDetailMachine;
      if (machines.some(machine => machine.id === prior)) machineSelect.value = prior;
      showMachine();
      await refreshDetails();
    }
  }
  async function refreshRecordedTopups() {
    const request = ++topupHistoryRequest; const user = currentUser?.id;
    const rows = document.getElementById('demoRecordedTopupsRows');
    const status = document.getElementById('demoRecordedTopupsStatus');
    try {
      const data = await api('demo/topups/recorded');
      if (request !== topupHistoryRequest || currentUser?.id !== user) return;
      rows.replaceChildren(); document.getElementById('demoRecordedTopups').hidden = false;
      for (const record of data.records) {
        const entry = record.entry; const row = document.createElement('tr');
        const values = [entry?.created_at || '—', entry?.actor || '—', entry?.card_uid || '—', entry ? (entry.amount_cents / 100).toFixed(2) + ' TL' : '—', record.request_key, record.status === 'recorded' ? 'Kayıt doğrulandı' : 'Tutarsız — inceleme gerekli'];
        for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        rows.append(row);
      }
      status.textContent = data.records.length ? 'Yalnızca sunucuda bulunan kayıtlar gösteriliyor.' : 'Gösterilecek doğrulanmış kayıt yok; eksik isteklerin sonucu bilinmiyor.';
    } catch (error) {
      if (request === topupHistoryRequest && currentUser?.id === user) { rows.replaceChildren(); document.getElementById('demoRecordedTopups').hidden = false; status.textContent = `Merkez kayıtları okunamadı: ${error.message}. Sonuç bilinmiyor.`; }
    }
  }
  document.getElementById('demoRecordedTopupsRefresh').addEventListener('click', refreshRecordedTopups);
  async function refreshOpenIntents() {
    const request = ++intentRequest; const userId = currentUser?.id;
    const rows = document.getElementById('demoOpenIntentsRows'); const status = document.getElementById('demoOpenIntentsStatus');
    try {
      const data = await api('demo/topup-intents');
      if (request !== intentRequest || currentUser?.id !== userId) return;
      rows.replaceChildren(); document.getElementById('demoOpenIntents').hidden = false;
      for (const intent of data.intents) {
        const item = document.createElement('li'); item.className = 'mb-2';
        const label = document.createElement('span');
        label.textContent = `${intent.createdAt} · ${intent.payload.cardUid || 'Kart yok'} · ${(intent.payload.amountCents / 100).toFixed(2)} TL · ${intent.id} `;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-sm btn-outline-warning'; button.textContent = 'Bu isteği tamamla';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const result = await api('demo/topup-intents/execute', { intentId: intent.id });
            const local = PendingDemoTopups.list().find(p => p.userId === userId && p.body.idempotencyKey === intent.id);
            if (local) PendingDemoTopups.clear(local);
            await refresh(intent.payload.cardUid);
            tell(`${result.duplicate ? 'Önceki yükleme doğrulandı' : 'Yükleme tamamlandı'}: ${result.entryId}.`);
          } catch (error) { tell(`${error.message} Sonuç belirsizse aynı niyet kimliğiyle inceleyin.`); }
          finally { button.disabled = false; }
        });
        item.append(label, button); rows.append(item);
      }
      status.textContent = data.intents.length ? 'Yalnız giriş yapan kullanıcının merkeze kayıtlı açık niyetleri gösteriliyor.' : 'Kayıtlı açık niyet görünmüyor; diğer isteklerin sonucu bilinmiyor olabilir.';
    } catch (error) {
      if (request === intentRequest && currentUser?.id === userId) { rows.replaceChildren(); document.getElementById('demoOpenIntents').hidden = false; status.textContent = `Açık niyetler okunamadı: ${error.message}. Sonuç bilinmiyor.`; }
    }
  }
  document.getElementById('demoOpenIntentsRefresh').addEventListener('click', refreshOpenIntents);
  document.getElementById('demoTopupLookupForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    const result = document.getElementById('demoTopupLookupResult');
    const requestingUser = currentUser?.id;
    button.disabled = true; result.textContent = '';
    try {
      const data = await api('admin/topups/lookup', { idempotencyKey: document.getElementById('demoTopupLookupKey').value.trim() });
      if (currentUser?.id !== requestingUser || currentUser?.role !== 'admin') return;
      if (data.status === 'recorded') {
        const entry = data.entry;
        result.textContent = `Merkezde yükleme kaydı var: ${entry.id} · ${entry.created_at} UTC · ${entry.actor || 'Kullanıcı belirtilmemiş'} · ${entry.card_uid || 'Kart belirtilmemiş'} · ${(entry.amount_cents / 100).toFixed(2)} TL. İşlem sonrası hesap bakiyesi: ${(entry.balance_after_cents / 100).toFixed(2)} TL; bu güncel bakiye olmayabilir.`;
      } else if (data.status === 'inconsistent') result.textContent = 'Kayıt tutarsız; sonuç doğrulanamadı. İnceleme gerekir, otomatik işlem yapılmadı.';
      else result.textContent = 'Merkezde bu kimlikle doğrulanmış yükleme bulunamadı. Sonuç bilinmiyor: istek ulaşmamış veya sürüyor olabilir; yeni yükleme ya da iade yapılmadı.';
    } catch (error) { if (currentUser?.id === requestingUser && currentUser?.role === 'admin') result.textContent = `Sorgu tamamlanamadı: ${error.message} Sonuç bilinmiyor.`; }
    finally { button.disabled = false; }
  });
  function detailQuery() {
    const query = new URLSearchParams();
    for (const [name, id] of [['from', 'demoDetailFrom'], ['to', 'demoDetailTo'], ['machineId', 'demoDetailMachine'], ['type', 'demoDetailType']]) {
      const value = document.getElementById(id).value; if (value) query.set(name, value);
    }
    return query;
  }
  async function refreshDetails() {
    const request = ++detailRequest;
    const query = detailQuery(); query.set('page', String(detailPage));
    try {
      const data = await api('admin/history/details?' + query);
      if (request !== detailRequest) return;
      const tbody = document.getElementById('demoDetailRows'); tbody.replaceChildren();
      const types = { topup: 'Yükleme', game_charge: 'Oyun harcaması', correction: 'Düzeltme', refund: 'İade kaydı', bonus: 'Bonus kaydı', free_play: 'Ücretsiz oyun kaydı' };
      const statuses = { pending: 'Bekliyor', succeeded: 'Testte başarılı', ambiguous: 'Belirsiz', failed: 'Testte başarısız' };
      for (const entry of data.rows) {
        const row = document.createElement('tr');
        const device = entry.machine_id ? `${entry.machine_name || entry.machine_id} (${entry.machine_id}) / ${statuses[entry.command_status] || 'Komut kaydı yok'}` : '—';
        const type = (types[entry.entry_type] || entry.entry_type) + (entry.entry_type === 'free_play' && entry.note ? ` — ${entry.note}` : '');
        for (const value of [entry.created_at, type, `${entry.account_name || '—'} / ${entry.card_uid || '—'}`, (entry.amount_cents / 100).toFixed(2), (entry.balance_after_cents / 100).toFixed(2) + ' TL', device, entry.id]) {
          const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
        }
        tbody.append(row);
      }
      document.getElementById('demoDetailStatus').textContent = `Toplam ${data.total} hareket · Sayfa ${data.page} (25 hareket/sayfa).`;
      document.getElementById('demoDetailPrevious').disabled = detailPage <= 1;
      document.getElementById('demoDetailNext').disabled = detailPage * data.pageSize >= data.total;
    } catch (error) {
      if (request === detailRequest) { document.getElementById('demoDetailRows').replaceChildren(); document.getElementById('demoDetailStatus').textContent = error.message; }
    }
  }
  document.getElementById('demoDetailForm').addEventListener('submit', event => { event.preventDefault(); detailPage = 1; refreshDetails(); });
  document.getElementById('demoDetailPrevious').addEventListener('click', () => { if (detailPage > 1) { detailPage--; refreshDetails(); } });
  document.getElementById('demoDetailNext').addEventListener('click', () => { detailPage++; refreshDetails(); });
  document.getElementById('demoDetailCsv').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const response = await fetch('/phase1/api/admin/history/details.csv?' + detailQuery());
      if (!response.ok) { const data = await response.json(); throw new Error(data.message || 'CSV indirilemedi.'); }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a');
      link.href = url; link.download = 'opencredit-demo-hareketler.csv'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000); tell('Ayrıntılı hareketler indirildi.');
    } catch (error) { tell(error.message); } finally { button.disabled = false; }
  });
  document.getElementById('demoPulseRefresh').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await refresh(); tell('Test komutu geçmişi yenilendi.'); }
    catch (error) { tell(error.message); }
    finally { button.disabled = false; }
  });
  async function refreshReport() {
    const request = ++reportRequest;
    try {
      const date = document.getElementById('demoReportDate').value;
      const data = await api('report/period?period=' + encodeURIComponent(document.getElementById('demoReportPeriod').value) + (date ? '&date=' + encodeURIComponent(date) : ''));
      if (request !== reportRequest) return;
      const report = data.report;
      const tl = cents => (cents / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
      document.getElementById('demoReportTotals').textContent = `İstanbul dönemi: ${report.start} – ${report.end} (bitiş hariç) · Dönem yüklemesi: ${tl(report.totals.topups_cents)} · Dönem oyun harcaması: ${tl(report.totals.game_charges_cents)} · Dönem net düzeltmesi: ${tl(report.totals.corrections_cents)} · Ücretsiz oyun: ${report.totals.free_plays_count} adet · Şu anki toplam bakiye: ${tl(report.balance_cents)}`;
      const status = report.commandStatus;
      document.getElementById('demoReportCommands').textContent = `Test komutu sonucu belirsiz kesinti: ${tl(status.ambiguous)} · Bekleyen: ${tl(status.pending)} · Başarısız: ${tl(status.failed)} · Komut kaydı bulunmayan: ${tl(status.missing)} · Testte başarılı: ${tl(status.succeeded)}`;
      const chart = document.getElementById('demoReportChart');
      chart.replaceChildren();
      const maximum = Math.max(1, ...report.buckets.map(item => item.cents));
      for (const item of report.buckets) {
        const row = document.createElement('div');
        const label = document.createElement('span');
        label.textContent = `${item.label} — ${tl(item.cents)} `;
        const bar = document.createElement('span');
        bar.style.cssText = `display:inline-block;height:0.8em;background:#286090;width:${Math.round(item.cents / maximum * 140)}px`;
        bar.setAttribute('aria-hidden', 'true');
        row.append(label, bar);
        chart.append(row);
      }
      const list = document.getElementById('demoReportMachines');
      list.replaceChildren();
      if (!report.machines.length) {
        const item = document.createElement('li'); item.textContent = 'Bu dönemde oyun harcaması yok.'; list.append(item);
      }
      for (const machine of report.machines) {
        const item = document.createElement('li'); item.textContent = `${machine.name}${machine.machine_id ? ` (${machine.machine_id})` : ''}: ${tl(machine.cents)}`; list.append(item);
      }
    } catch (error) {
      if (request === reportRequest) {
        document.getElementById('demoReportTotals').textContent = 'Rapor yüklenemedi: ' + error.message;
        document.getElementById('demoReportCommands').replaceChildren();
        document.getElementById('demoReportChart').replaceChildren();
        document.getElementById('demoReportMachines').replaceChildren();
      }
    }
  }
  document.getElementById('demoReportPeriod').addEventListener('change', refreshReport);
  document.getElementById('demoReportDate').addEventListener('change', refreshReport);
  const freePlayKey = 'opencreditPendingDemoFreePlay';
  function pendingFreePlay() { return JSON.parse(sessionStorage.getItem(freePlayKey) || 'null'); }
  function showPendingFreePlay() {
    const label = document.getElementById('demoFreePlayPending'); const retry = document.getElementById('demoFreePlayRetry');
    try {
      const pending = pendingFreePlay();
      label.hidden = !pending; retry.hidden = !pending;
      if (pending) label.textContent = currentUser?.id === pending.userId ? `Sonucu bilinmeyen ücretsiz oyun: ${pending.body.machineId} · ${pending.body.cardUid}. Aynı istekle doğrulayın; yeni işlem başlatılamaz.` : 'Başka yöneticiye ait bekleyen ücretsiz oyun var; o kullanıcıyla doğrulayın.';
    } catch (_) { label.hidden = false; retry.hidden = true; label.textContent = 'Bekleyen ücretsiz oyun kaydı okunamıyor; yeni işlem göndermeyin.'; }
  }
  async function sendFreePlay() {
    let pending;
    try { pending = pendingFreePlay(); } catch (_) { showPendingFreePlay(); return; }
    if (!pending) return;
    if (currentUser?.id !== pending.userId || currentUser?.role !== 'admin') return tell('İşlemi başlatan yöneticiyle giriş yapın.');
    const button = document.querySelector('#demoFreePlayForm button'); const retry = document.getElementById('demoFreePlayRetry');
    if (button.disabled || retry.disabled) return;
    button.disabled = true; retry.disabled = true;
    try {
      const result = await api('admin/demo/free-play', pending.body);
      sessionStorage.removeItem(freePlayKey); showPendingFreePlay();
      document.getElementById('demoFreePlayForm').reset();
      await refresh(pending.body.cardUid);
      tell(`${result.duplicate ? 'Önceki ücretsiz oyun doğrulandı' : 'Ücretsiz oyun kaydedildi'}; test komutu ${result.pulseCommandId}. Bakiye değişmedi.`);
    } catch (error) { tell(`${error.message} Bekleyen isteği korunuyor; aynı istekle doğrulayın.`); }
    finally { button.disabled = false; retry.disabled = false; }
  }
  document.getElementById('demoFreePlayForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentUser || currentUser.role !== 'admin' || !card) return tell('Önce yönetici olarak giriş yapıp kart seçin.');
    try {
      if (pendingFreePlay()) return tell('Önce bekleyen ücretsiz oyun isteğini doğrulayın.');
      const body = { machineId: document.getElementById('demoMachine').value, cardUid: card.uid, reason: document.getElementById('demoFreePlayReason').value.trim(), idempotencyKey: 'freeplay-' + crypto.randomUUID() };
      if (body.reason.length < 10) return tell('Gerekçe en az 10 karakter olmalıdır.');
      sessionStorage.setItem(freePlayKey, JSON.stringify({ userId: currentUser.id, body }));
      showPendingFreePlay(); await sendFreePlay();
    } catch (_) { tell('Bekleyen isteği kaydedilemedi veya okunamadı; yeni işlem göndermeyin.'); }
  });
  document.getElementById('demoFreePlayRetry').addEventListener('click', sendFreePlay);
  document.getElementById('demoReportCsv').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const date = document.getElementById('demoReportDate').value;
      const query = new URLSearchParams({ period: document.getElementById('demoReportPeriod').value });
      if (date) query.set('date', date);
      const response = await fetch('/phase1/api/report/period.csv?' + query);
      if (!response.ok) { const data = await response.json(); throw new Error(data.message || 'CSV indirilemedi.'); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url; link.download = 'opencredit-demo-rapor.csv';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      tell('Seçili dönem raporu indirildi.');
    } catch (error) { tell(error.message); }
    finally { button.disabled = false; }
  });
  function showMachine() {
    const machine = machines.find(item => item.id === document.getElementById('demoMachine').value);
    if (!machine) return;
    document.getElementById('demoMachineName').value = machine.name;
    document.getElementById('demoPrice').value = (machine.price_cents / 100).toFixed(2);
    document.getElementById('demoPulseMs').value = machine.pulse_ms;
    document.getElementById('demoPulseCount').value = machine.pulse_count;
    document.getElementById('demoPulseGap').value = machine.pulse_gap_ms;
    document.getElementById('demoMachineEnabled').checked = machine.enabled;
    document.getElementById('demoCardRemovedMs').value = machine.card_removed_ms;
    document.getElementById('demoPaymentCooldownMs').value = machine.payment_cooldown_ms;
    document.getElementById('demoLedEnabled').checked = machine.led_enabled;
    document.getElementById('demoLedBrightness').value = machine.led_brightness;
    const labels = { pending: 'Bekliyor', applied: 'Testte uygulandı', failed: 'Test başarısız' };
    const lastApplied = machine.simulated_applied_version === null ? 'Henüz test edilmedi' : `Son test sürümü ${machine.simulated_applied_version}`;
    document.getElementById('demoSettingsStatus').textContent = `Ayar sürümü ${machine.settings_version}, test LED raporu: ${labels[machine.settings_status]}. ${lastApplied}. Gerçek cihaz doğrulaması yok.`;
  }
  document.getElementById('demoMachine').addEventListener('change', showMachine);
  document.getElementById('demoLedForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      await api('machines/' + encodeURIComponent(document.getElementById('demoMachine').value) + '/led', {
        enabled: document.getElementById('demoLedEnabled').checked,
        brightness: Number(document.getElementById('demoLedBrightness').value)
      }, 'PATCH');
      await refresh();
      tell('LED ayarı kaydedildi. Durum seçili makinede gösteriliyor.');
    } catch (error) { tell(error.message); }
    finally { button.disabled = false; }
  });
  document.getElementById('demoCreateMachineForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const result = await api('machines', { id: document.getElementById('demoNewMachineId').value, name: document.getElementById('demoNewMachineName').value, priceTl: document.getElementById('demoNewMachinePrice').value });
      form.reset();
      await refresh();
      document.getElementById('demoMachine').value = result.machine.id;
      showMachine();
      tell(`makine eklendi: ${result.machine.name}.`);
    } catch (error) { tell(error.message); }
    finally { button.disabled = false; }
  });
  document.getElementById('demoTimingForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      await api('machines/' + encodeURIComponent(document.getElementById('demoMachine').value) + '/timing', {
        cardRemovedMs: document.getElementById('demoCardRemovedMs').value,
        paymentCooldownMs: document.getElementById('demoPaymentCooldownMs').value
      }, 'PATCH');
      await refresh();
      tell('kart okuma süreleri kaydedildi.');
    } catch (error) { tell(error.message); }
    finally { button.disabled = false; }
  });
  const attachKey = 'opencreditPendingCardLink';
  function showPendingCardLink() {
    const pending = JSON.parse(sessionStorage.getItem(attachKey) || 'null');
    const message = document.getElementById('demoAttachPending');
    message.hidden = !pending;
    document.getElementById('demoAttachRetry').hidden = !pending;
    if (pending) message.textContent = `Sonucu bilinmeyen kart bağlama: ${pending.body.uid} · ${pending.body.accountId}. Aynı kullanıcıyla doğrulayın.`;
  }
  async function sendCardLink() {
    const pending = JSON.parse(sessionStorage.getItem(attachKey) || 'null');
    if (!pending) return;
    if (!currentUser || currentUser.id !== pending.userId) return tell('İşlemi başlatan kullanıcıyla giriş yapın.');
    const button = document.querySelector('#demoAttachCardForm button');
    const retry = document.getElementById('demoAttachRetry');
    if (button.disabled || retry.disabled) return;
    button.disabled = true;
    retry.disabled = true;
    try {
      const result = await api('demo/attach-card', pending.body);
      sessionStorage.removeItem(attachKey);
      showPendingCardLink();
      document.getElementById('demoAttachCardForm').reset();
      await refresh(result.card.uid);
      tell(`Kart ${result.card.uid} hesaba ${result.duplicate ? 'önceden bağlanmış' : 'bağlandı'}.`);
    } catch (error) {
      if (error.status === 400 || error.status === 404 || error.code === 'card_exists' || error.code === 'account_locked') { sessionStorage.removeItem(attachKey); showPendingCardLink(); }
      tell(error.message);
    } finally { button.disabled = false; retry.disabled = false; }
  }
  document.getElementById('demoAttachCardForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!account || !currentUser) return tell('Önce giriş yapın.');
    if (sessionStorage.getItem(attachKey)) return tell('Önce bekleyen kart bağlamayı doğrulayın.');
    sessionStorage.setItem(attachKey, JSON.stringify({ userId: currentUser.id, body: {
      accountId: account.id, uid: document.getElementById('demoAttachUid').value,
      idempotencyKey: 'attach-' + crypto.randomUUID()
    } }));
    showPendingCardLink();
    await sendCardLink();
  });
  document.getElementById('demoAttachRetry').addEventListener('click', sendCardLink);
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
      tell(locked ? 'kart engellendi.' : 'kart engeli kaldırıldı.');
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
      tell(`düzeltme ${result.duplicate ? 'doğrulandı' : 'kaydedildi'}: ${result.entryId}.`);
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
      await refresh();
      tell(`Personel hesabı oluşturuldu: ${result.user.username}.`);
    } catch (error) { tell(error.message); }
    finally { button.disabled = false; }
  });
  document.getElementById('demoResetIssueForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    const output = document.getElementById('demoResetIssueResult');
    output.textContent = '';
    try {
      const result = await api('admin/staff/' + encodeURIComponent(document.getElementById('demoResetStaff').value) + '/demo-password-reset', { adminPassword: document.getElementById('demoResetAdminPassword').value });
      document.getElementById('demoResetAdminPassword').value = '';
      output.textContent = `${result.username} için tek kullanımlık kod: ${result.token} — Son geçerlilik (UTC): ${result.expiresAt}. Personel ayrı, özel bir tarayıcı oturumunda kullanmalıdır.`;
    } catch (error) { document.getElementById('demoResetAdminPassword').value = ''; tell(error.message); }
    finally { button.disabled = false; }
  });
  document.getElementById('demoResetForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    if (button.disabled) return;
    if (document.getElementById('demoResetPassword').value !== document.getElementById('demoResetConfirm').value) return tell('Yeni parolalar eşleşmiyor.');
    button.disabled = true;
    try {
      await api('auth/demo-password-reset', { username: document.getElementById('demoResetUsername').value, token: document.getElementById('demoResetToken').value, newPassword: document.getElementById('demoResetPassword').value });
      form.reset();
      tell('personel parolası yenilendi; yeni parolayla giriş yapın.');
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
      tell('Makine ayarları kaydedildi.');
    } catch (error) { tell(error.message); }
    finally { button.disabled = false; }
  });
  document.getElementById('demoCardChoice').addEventListener('change', async event => {
    const select = event.currentTarget;
    const correctionButton = document.querySelector('#demoCorrectionForm button');
    const attachButton = document.querySelector('#demoAttachCardForm button');
    const lockButton = document.getElementById('demoCardLock');
    const depositButton = document.querySelector('#depositModal .modal-footer .btn-primary');
    select.disabled = true;
    correctionButton.disabled = true;
    attachButton.disabled = true;
    lockButton.disabled = true;
    depositButton.disabled = true;
    try { await refresh(select.value); }
    catch (error) { account = null; card = null; tell(error.message); }
    finally { select.disabled = false; correctionButton.disabled = false; attachButton.disabled = false; lockButton.disabled = false; depositButton.disabled = false; }
  });
  window.registerUser = async () => {
    const button = document.querySelector('#newCardModal .modal-footer .btn-primary');
    if (button.disabled) return;
    button.disabled = true;
    registerKey ||= 'registration-' + crypto.randomUUID();
    try {
      const result = await api('demo/register', { name: document.getElementById('userName').value, phone: document.getElementById('userContact').value, uid: document.getElementById('cardNum').value, idempotencyKey: registerKey });
      registerKey = null;
      await refresh(result.card.uid);
      tell('Müşteri ve kart oluşturuldu.');
      window.$('#newCardModal').modal('hide');
    } catch (error) { tell(error.message + ' Aynı isteği tekrar deneyebilirsiniz.'); }
    finally { button.disabled = false; }
  };
  for (const id of ['userName', 'userContact', 'cardNum']) document.getElementById(id).addEventListener('input', () => { registerKey = null; });
  document.getElementById('demoLogin').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const status = await api('setup/status');
      await api(status.setupRequired ? 'setup' : 'auth/login', { username: document.getElementById('demoUsername').value, password: document.getElementById('demoPassword').value });
      document.getElementById('demoPassword').value = '';
      await refresh();
      tell('Giriş yapıldı. Yükleme düğmesiyle bakiye ekleyebilirsiniz.');
    } catch (error) { tell(error.message); }
  });
  function getPending() { return PendingDemoTopups.list()[0] || null; }
  function showPending() {
    const message = document.getElementById('demoPendingNotice');
    const retry = document.getElementById('demoRetryTopup');
    try {
      const pending = getPending();
      message.hidden = !pending;
      retry.hidden = !pending;
      if (pending) message.textContent = currentUser?.id === pending.userId
        ? `Sonucu bilinmeyen yükleme: ${pending.body.cardUid} · ${pending.body.amountTl} TL · İstek kimliği: ${pending.body.idempotencyKey}. Aynı kullanıcıyla doğrulayın; yeni yükleme başlatılamaz.`
        : 'Bu tarayıcıda başka bir kullanıcının bekleyen yüklemesi var; işlemi başlatan kullanıcıyla doğrulayın.';
    } catch (_) { message.hidden = false; retry.hidden = true; message.textContent = 'Bekleyen kaydı okunamıyor; yeni yükleme başlatılmadı. Tarayıcı verisini silmeyin ve durumu inceleyin.'; }
  }
  async function sendPendingTopup() {
    let pending;
    try { pending = getPending(); } catch (_) { showPending(); return; }
    if (!pending) return;
    if (!currentUser || currentUser.id !== pending.userId) return tell('Bekleyen yüklemeyi başlatan kullanıcıyla giriş yapın.');
    const button = document.querySelector('#depositModal .modal-footer .btn-primary');
    const retry = document.getElementById('demoRetryTopup');
    if (button.disabled || retry.disabled) return;
    button.disabled = true;
    retry.disabled = true;
    try {
      await api('demo/topup-intents', pending.body);
      const result = await api('demo/topup-intents/execute', { intentId: pending.body.idempotencyKey });
      PendingDemoTopups.clear(pending);
      showPending();
      await refresh(pending.body.cardUid);
      tell(`${result.duplicate ? 'Önceki yükleme doğrulandı' : 'Yükleme tamamlandı'}. İşlem ${result.entryId}; bakiye ${result.balanceAfterTl} TL.`);
      window.$('#depositModal').modal('hide');
    } catch (error) {
      tell(error.message + ' Kayıt korunuyor; sonuç belirsizse inceleyin ve aynı istekle doğrulayın.');
    } finally { button.disabled = false; retry.disabled = false; }
  }
  window.depositCredits = async () => {
    if (!account || !card || !currentUser) return tell('Önce giriş yapın.');
    const amountTl = document.getElementById('depositBalance').value;
    if (!PendingDemoTopups.validAmount(amountTl)) return tell('Geçerli pozitif tutarı girin (en fazla iki ondalık).');
    try { if (getPending()) return tell('Önce bekleyen yüklemeyi doğrulayın.'); }
    catch (_) { showPending(); return; }
    const pending = { userId: currentUser.id, body: { accountId: account.id, cardUid: card.uid, amountTl, idempotencyKey: 'topup-' + crypto.randomUUID() } };
    try { PendingDemoTopups.save(pending); } catch (_) { tell('isteği tarayıcıya kaydedilemedi; yükleme gönderilmedi.'); return; }
    showPending();
    await sendPendingTopup();
  };
  document.getElementById('demoRetryTopup').addEventListener('click', sendPendingTopup);
  window.addEventListener('storage', showPending);
  refresh().catch(() => {});
})();
