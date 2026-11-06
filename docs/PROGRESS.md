# İlerleme

Tarih: 2026-11-06  
Branch: `codex/phase1-local-demo-20261106`  
Temel commit: `c96727c2d76d54179b67c1fcc34fc4cb1a8a5466`

## Durum

Faz 1’in yerel gösterilebilir prototipi tamamlandı. Demo aynı mevcut Express projesine `/phase1` altında mount edilebilir; legacy JSON/Pug akışı korunmuştur. Demo veritabanı `phase1-data/demo.sqlite` altında, gerçek kullanıcı verilerinden ayrı tutulur.

## Test kanıtı

`node --test phase1/test/*.test.js` sonucu: **6 test geçti, 0 başarısız**.

Kapsanan kritik akışlar: 200 TL yükleme ve 25 TL ödeme sonrası 175 TL, aynı idempotency anahtarında ikinci düşüm/pulse olmaması, iki ödeme yarışında en fazla bir onay, kart çekilmeden yeni ödeme reddi, belirsiz pulse’ın aynı komutla yeniden denenmesi, pulse süresi sınırı, UID normalizasyonu, fiyat ayarı snapshot’ı, yeniden açılışta kalıcılık ve personel API yetki reddi.

Bağımlılık kurulumu `NPM_CONFIG_CACHE=/tmp/opencreditic-npm-cache npm ci` ile tamamlandı. Node.js `v24.22.1`; paket gereksinimi `>=22.5.0` çünkü Faz 1 yerleşik `node:sqlite` kullanır.

## Çalıştırma

```text
npm ci
npm run phase1
```

Tarayıcı: `http://127.0.0.1:1787/phase1`  
Mevcut legacy sunucu ile: `node card-server.js` sonrası `http://localhost:1777/phase1` (yerel `config.json` mevcut olmalıdır).

Yedek:

```text
npm run phase1:backup -- --output phase1-backups/demo-copy.sqlite
```

Kaynak veritabanını durdurmadan restore yapılmaz; yedek doğrulandıktan sonra yeni bir hedef dosyada kontrollü geri yükleme yapılır. Gerçek `cards.json` veya `history.json` bu Faz 1’e otomatik aktarılmaz.

## Sınırlar

Gerçek RFID, ESP32, TFT, LED, ticket hattı, GPIO, fiziksel pulse, POS, bulut ve internetten erişim doğrulanmadı ve çalışıyor gibi sunulmuyor. “Üretime hazır” iddiası yoktur.
