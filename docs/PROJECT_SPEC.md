# MCK Kartlı Oyun Sistemi — Proje şartnamesi

Bu belge, Library’deki `MCK_CARD_CODEX_BASLANGIC(1).txt` başlangıç şartnamesinin bu depoya uygulanmış Faz 1 karşılığıdır. Kaynak şartname 193 satır ve 17.757 bayttır.

## Kesin Faz 1 kapsamı

- Mevcut Node.js/Express projesi korunur; `card-server.js` ve Pug arayüzü silinmez.
- Yerel merkez için ayrı demo SQLite veritabanı kullanılır. TL tutarları tam sayı kuruş, ticket ayrı tam sayı olarak saklanır.
- İlk yönetici kurulumu, parola hash’i, oturum cookie’si ve `admin`/`staff` sunucu tarafı yetkisi bulunur.
- Hesap, kart, kart kilidi, makine fiyatı ve pulse parametreleri yönetilir.
- Yükleme ve ödeme kayıtları idempotenttir; fiyat sunucudaki makine ayarından alınır.
- Onaylı ödeme bir pulse komutu oluşturur. Fiziksel pulse ile muhasebe atomikmiş gibi gösterilmez; `pending`, `succeeded`, `ambiguous`, `failed` durumları ayrıdır.
- Sanal kart yaklaştırma/tutma/çekme, 128×160 oranlı ekran önizlemesi ve sanal LED bulunur.
- Demo `DEMO / GERÇEK DONANIM DEĞİL` olarak işaretlenir ve gerçek GPIO/RFID/pulse çalıştırmaz.

## Bu fazda olmayanlar

ESP32/RC522/TFT/WS2812B firmware’i, gerçek pulse çıkışı, e-ticket donanım kabulü, POS/kasa okuyucusu, müşteri kiosku, banka/POS ödeme, bulut/uzaktan yönetim, OTA, üretim PCB/CAD ve gerçek veriye migration yoktur.

## Uygulama sınırı

`phase1/` demo çekirdeğini içerir; `npm run phase1` mevcut `card-server.js` girişini demo modunda açar ve Pug görünümünü `/phase1` altında sunar. Bu modda legacy endpoint'ler kayıt edilmez. Normal `npm start` mevcut JSON/Pug akışını kullanır ve yeni SQLite bakiyesi ile bağlantılı değildir.
