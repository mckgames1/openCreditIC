# Depo denetimi

Denetim tarihi: 2026-11-06  
İncelenen HEAD: `c96727c2d76d54179b67c1fcc34fc4cb1a8a5466` — `Corrected new card using manual entry`  
Upstream remote: `https://github.com/mckgames1/openCreditIC.git`  
Başlangıç remote HEAD: `main` ve yerel `work` aynı committeydi.

## Var olanlar

| Alan | Kanıt | Faz 1 karşılığı |
|---|---|---|
| Express sunucusu | `card-server.js:1-2155` | Korundu; yeni demo `/phase1` altında mount edildi. |
| JSON veri akışı | `card-server.js:9-68`, `example-cards.json`, `example-history.json` | Gerçek veriye migration yapılmadı; demo SQLite ayrıdır. |
| Pug web arayüzü | `web/views/home.pug`, `user-data.pug`, `free_play-config.pug` | Korundu; Faz 1 ekranı ayrıca `phase1/public/` altında. |
| Cihaz/ödeme endpoint’leri | `card-server.js:231+`, özellikle `/dispense` ve `/callback` | Eski akışın güvenlik/idempotency garantileri yok; yeni Faz 1 ödeme yolu bunları canlı para akışı olarak kullanmaz. |
| ESP32 firmware | `CardReader-Game/CardReader-Game.ino`, `CardReader-POS/CardReader-POS.ino` | Mevcut firmware hedef donanımdan farklı noktalar içeriyor; firmware fazına bırakıldı. |
| Yerel ağ hedefi | README kurulum ve `localhost:1777` | Faz 1 demo varsayılanı `127.0.0.1:1787`; LAN’a otomatik açılmaz. |

## Eksikler ve kritik riskler

- Mevcut `card-server.js` JSON dosyalarına yazıyor; transaction, kuruş para, idempotency ve pulse komut günlüğü garantileri yok.
- Eski yönetim kimlik doğrulaması `config.json` içindeki URL query anahtarına dayanıyor; bu Faz 1’in oturum/parola/yetki akışının yerine geçirilmiyor.
- README’de projeye ait açık bir lisans dosyası veya SPDX bildirimi yok. README’deki ticari kullanım sorumluluk uyarısı korunuyor; ticari dağıtım lisansı hakkında kesin hüküm verilmedi.
- RC522 UID kontrolü kopyalanamaz kart güvenliği değildir; Faz 1 bu fiziksel sınırı değiştirmez.
- Firmware’de README OLED örnekleri bulunuyor; şartname TFT hedefini kesinleştiriyor. Pin, panel varyantı, NO/NC çıkış ve ticket elektriksel protokolü açık sorudur.

## Yeni Faz 1 dosyaları

`phase1/core.js` SQLite şeması ve atomik iş kuralları, `phase1/server.js` mount edilebilir Express API’si, `phase1/public/` demo arayüzü, `phase1/test/` otomatik testleri, `phase1/scripts/backup.js` yedekleme yardımcısıdır.
