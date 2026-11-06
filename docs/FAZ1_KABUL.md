# Faz 1 kabul durumu

Kaynak: `MCK_CARD_CODEX_BASLANGIC(1).txt`, bölüm 10. Durum 2026-11-06; yalnız demo, gerçek para/donanım yok.

## Tamamlanan ve doğrulanan

- SQLite, kuruş bazlı bakiye ve işlem/komut kalıcılığı: `phase1/core.js`; süreç kesintisi testleri `phase1/test/crash.test.js`.
- Demo yükleme/oyun, aynı istek tekrarı ve yetersiz bakiye: `phase1/test/http.test.js`. Chromium'da 200 TL yükleme, 50 TL oyun ve 150 TL bakiye denendi.
- İki bağımsız süreçte 25 TL yarışında tek harcama/komut: `phase1/test/concurrency.test.js`; gerçek okuyucu testi değildir.
- Canlı WAL yedeği ve yeni dosyaya geri yükleme: `phase1/test/backup.test.js`.
- Admin/staff sunucu yetkisi, personelin kendi geçmişi: `phase1/server.js`, `phase1/test/http.test.js`.
- Yönetici ana Pug ekranından seçili demo kartı engelleyebilir veya engeli kaldırabilir; engelli kartta ödeme ve komut reddi ile yeniden başlatma test edildi: `web/static/js/demo-home.js`, `phase1/test/http.test.js`.
- Mevcut demo hesaba birden fazla sanal kart bağlanabilir; ortak bakiye ve tekrar istek test edildi. Bu, fiziksel kart kayıt akışı değildir: `web/views/home.pug`, `phase1/test/http.test.js`.
- Yönetici Pug ekranında ayrı kart çekme ve ödeme bekleme sürelerini ayarlayabilir; kısa çekilme, bekleme ve yetki demo API'sinde test edildi. Ayarlar cihaz bazlı değil, demo genelindedir.
- Sanal ekran, kart yaklaştırma/tutma/çekme, komut geçmişi ve basit tahsilat/harcama/bakiye: `web/views/home.pug`, `phase1/public/`.

## Kısmi

- Yönetim arayüzünün kayıt, yükleme, makine ayarları ve özet bölümleri mevcut Pug ana sayfasında; simülatör ve komut incelemesi ayrı demo görünümündedir.
- Yönetici Pug ana sayfasında demo personeli oluşturabilir; personel parolası scrypt ile saklanır. Personel parola sıfırlama ve hesap devre dışı bırakma arayüzleri henüz yoktur.
- Belirsiz komut yönetici gerekçesiyle kaydedilir. Demo için yöneticinin gerekçeli artı/eksi bakiye düzeltmesi vardır; bu ayrı bir kayıttır, otomatik iade veya gerçek ödeme değildir (`phase1/core.js`, `phase1/server.js`).
- Cihaz fiyat/pulse ayarları ve işlem anlık kopyası var; cihaz başına LED, ayrı bekleme değerleri ve uygulama durumu yönetimi tamamlanmadı.
- Yükleme tekrarı API'de idempotent; ana Pug ekranında aynı sekmedeki yanıt kaybı ve yenileme kurtarma akışı var. Sekme kapatma, tarayıcı kapanması, diğer ekran ve farklı cihaz oturumları kapsanmaz.
- Simülatör kart kaldırma ve bekleme mantığı var; kısa RF kopması fiziksel okuyucuda test edilmedi.
- İşlem türleri veri modelinde ayrılabilse de iade, bonus, ücretsiz oyun işlemleri ve raporları uçtan uca tamamlanmadı.
- Yerel varlıklar mevcut; gerçek internet kesilerek tam çevrimdışı kabul testi yapılmadı.

## Yapılmayan

- Gerçek okuyucu, GPIO veya fiziksel pulse testleri; Faz 2 kapsamındadır.
- Windows betikleri eklendi; yerel Windows testinden 18/18 sonucu ve test uyumluluğu düzeltmeleri bildirildi. Bu çalışma ortamında Windows testi tekrar edilmedi.
- Gerçek para işlemleri, iade politikası ve tamamlanmamış Faz 1 kabul testleri; üretime hazırlık iddiası yoktur.
- Gerçek JSON bakiyelerinin dönüştürülmesi; demo ayrı SQLite kullanır.

## Kullanıcı kararı / doğrulama gerektirenler

- Eski `credit` değerlerinin TL'ye dönüşüm kuralı ve gerçek veriye geçiş, kullanıcı kararı ve yedekleme planı gerektirir; dönüşüm yapılmadı.
- Demo düzeltmede gerekçe ile artı/eksi hareket seçimi kullanılır; gerçek düzeltme/iade iş kuralları ve yetki prosedürü kullanıcı onayı gerektirir.
- Donanım panel varyantı, elektriksel çıkış/NO-NC, ticket sinyali ve sahiplik politikası henüz doğrulanmadı; `docs/OPEN_QUESTIONS.md`.
- Ticari dağıtım lisans durumu depodaki bildirimlerle netleştirilmelidir; yeni lisans atanmadı.
