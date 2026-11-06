# Faz 1 kabul durumu

Kaynak: `MCK_CARD_CODEX_BASLANGIC(1).txt`, bölüm 10. Durum 2026-11-06; yalnız demo, gerçek para/donanım yok.

## Tamamlanan ve doğrulanan

- SQLite, kuruş bazlı bakiye ve işlem/komut kalıcılığı: `phase1/core.js`; süreç kesintisi testleri `phase1/test/crash.test.js`.
- Demo yükleme/oyun, aynı istek tekrarı ve yetersiz bakiye: `phase1/test/http.test.js`. Chromium'da 200 TL yükleme, 50 TL oyun ve 150 TL bakiye denendi.
- İki bağımsız süreçte 25 TL yarışında tek harcama/komut: `phase1/test/concurrency.test.js`; gerçek okuyucu testi değildir.
- Canlı WAL yedeği ve yeni dosyaya geri yükleme: `phase1/test/backup.test.js`.
- Admin/staff sunucu yetkisi, personelin kendi geçmişi: `phase1/server.js`, `phase1/test/http.test.js`.
- Sanal ekran, kart yaklaştırma/tutma/çekme, komut geçmişi ve basit tahsilat/harcama/bakiye: `web/views/home.pug`, `phase1/public/`.

## Kısmi

- Yönetim arayüzünün kayıt, yükleme, makine ayarları ve özet bölümleri mevcut Pug ana sayfasında; simülatör ve komut incelemesi ayrı demo görünümündedir.
- Belirsiz komut yönetici gerekçesiyle kaydedilir; bakiye düzeltme/iade uygulanmaz (`phase1/core.js`, `phase1/server.js`).
- Cihaz fiyat/pulse ayarları ve işlem anlık kopyası var; cihaz başına LED, bekleme ve uygulama durumu yönetimi tamamlanmadı.
- Yükleme tekrarı API'de idempotent; ana Pug ekranında aynı sekmedeki yanıt kaybı ve yenileme kurtarma akışı var. Sekme kapatma, tarayıcı kapanması, diğer ekran ve farklı cihaz oturumları kapsanmaz.
- Simülatör kart kaldırma ve bekleme mantığı var; kısa RF kopması fiziksel okuyucuda test edilmedi.
- İşlem türleri veri modelinde ayrılabilse de iade, bonus, ücretsiz oyun işlemleri ve raporları uçtan uca tamamlanmadı.
- Yerel varlıklar mevcut; gerçek internet kesilerek tam çevrimdışı kabul testi yapılmadı.

## Yapılmayan

- Gerçek okuyucu, GPIO veya fiziksel pulse testleri; Faz 2 kapsamındadır.
- Windows kurulum/başlatma/test betikleri eklendi; Windows üzerinde gerçek çalıştırma doğrulaması yapılmadı.
- Gerekçeli parasal düzeltme/iade ve tamamlanmamış Faz 1 kabul testleri; üretime hazırlık iddiası yoktur.
- Gerçek JSON bakiyelerinin dönüştürülmesi; demo ayrı SQLite kullanır.

## Kullanıcı kararı / doğrulama gerektirenler

- Eski `credit` değerlerinin TL'ye dönüşüm kuralı ve gerçek veriye geçiş, kullanıcı kararı ve yedekleme planı gerektirir; dönüşüm yapılmadı.
- Donanım panel varyantı, elektriksel çıkış/NO-NC, ticket sinyali ve sahiplik politikası henüz doğrulanmadı; `docs/OPEN_QUESTIONS.md`.
- Ticari dağıtım lisans durumu depodaki bildirimlerle netleştirilmelidir; yeni lisans atanmadı.
