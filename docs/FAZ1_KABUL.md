# Faz 1 kabul durumu

Kaynak: `MCK_CARD_CODEX_BASLANGIC(1).txt`, bölüm 10. Durum 2026-11-06; yalnız demo, gerçek para/donanım yok.

## Tamamlanan ve doğrulanan

- SQLite, kuruş bazlı bakiye ve işlem/komut kalıcılığı: `phase1/core.js`; süreç kesintisi testleri `phase1/test/crash.test.js`.
- Demo yükleme/oyun, aynı istek tekrarı ve yetersiz bakiye: `phase1/test/http.test.js`. Chromium'da 200 TL yükleme, 50 TL oyun ve 150 TL bakiye denendi.
- Tanımsız sanal kartın ücret/komut üretmemesi, kart tutulurken gerçek bekleme süresi geçse de ikinci isteğin reddi ve kart gerçek bekleme süresince çekildikten sonra yeni ödemenin kabulü, izole demo HTTP testinde doğrulandı. Tutma/çekme akışı Chromium simülatöründe de denendi; gerçek okuyucu testi değildir.
- Yönetici gerekçeli ücretsiz demo oyun oluşturabilir; hesap bakiyesi değişmez, tek sanal komut ve ayrı ücretsiz oyun sayısı oluşur. Ücretli harcama ve yükleme toplamlarına eklenmez; bu gerçek işletme kuralı değildir.
- İki bağımsız süreçte 25 TL yarışında tek harcama/komut: `phase1/test/concurrency.test.js`; gerçek okuyucu testi değildir.
- Canlı WAL yedeği ve yeni dosyaya geri yükleme: `phase1/test/backup.test.js`.
- Admin/staff sunucu yetkisi, personelin kendi geçmişi: `phase1/server.js`, `phase1/test/http.test.js`.
- Yönetici ana Pug ekranından seçili demo kartı engelleyebilir veya engeli kaldırabilir; engelli kartta ödeme ve komut reddi ile yeniden başlatma test edildi: `web/static/js/demo-home.js`, `phase1/test/http.test.js`.
- Mevcut demo hesaba birden fazla sanal kart bağlanabilir; ortak bakiye ve tekrar istek test edildi. Bu, fiziksel kart kayıt akışı değildir: `web/views/home.pug`, `phase1/test/http.test.js`.
- Yönetici Pug ekranında cihaz bazlı kart çekme ve ödeme bekleme sürelerini ayarlayabilir; iki sanal cihaz, kısa çekilme, başlayan bekleme ve yetki demo API'sinde test edildi.
- Cihaz bazlı demo LED etkinlik/parlaklık ayarı ve sürümün sanal bekliyor/uygulandı/başarısız durumu vardır; `phase1/test/http.test.js`. Gerçek cihaza aktarım yapılmaz.
- Sanal ekran, kart yaklaştırma/tutma/çekme, komut geçmişi ve basit tahsilat/harcama/bakiye: `web/views/home.pug`, `phase1/public/`.
- Yönetici ana ekranında son 25 sanal komutun cihazı, tutarı, kimliği ve durumu ayrıca görünür; geçmiş diğer simülatör ekranından da korunur. Sanal sonuç fiziksel kredi kanıtı değildir.
- Simülatör ekranı fiyat, işlem, onay, kalan bakiye, yetersiz bakiye ve bağlantı kesik mesajlarını gösterir. Bağlantı kesik seçeneği yerel simülasyondur; gerçek ağ kesintisi yapılmadı.

## Kısmi

- Yönetim arayüzünün kayıt, yükleme, makine ayarları ve özet bölümleri mevcut Pug ana sayfasında; simülatör ve komut incelemesi ayrı demo görünümündedir.
- Yönetici Pug ana sayfasında demo personeli oluşturabilir, erişimini durdurup açabilir ve parolasını yeniden doğrulayarak 10 dakika geçerli tek kullanımlık demo yenileme kodu oluşturabilir. Personel kendi yeni parolasını belirler; eski oturumlar sona erer. Bu yerel demo akışı üretim için doğrulanmış değildir.
- Yönetici ana ekranında seçilen tarih için gün/hafta/ay/yıl İstanbul saatli demo oyun harcaması grafiği ve cihaz dağılımı vardır; belirsiz sanal komut kesintileri ayrıca belirtilir. Yükleme ve düzeltmeler ayrı, bakiye anlık gösterilir. Gerçek gelir veya muhasebe raporu yoktur.
- Seçili demo dönem özeti ve filtrelenmiş ayrıntılı demo hareketleri yönetici tarafından ayrı CSV dosyaları olarak indirilebilir; ayrıntılı geçmiş tarih, tür ve cihaz filtreleri ile sayfalanır. Windows Excel ile doğrulama henüz yoktur.
- Belirsiz komut yönetici gerekçesiyle kaydedilir. Demo için yöneticinin gerekçeli artı/eksi bakiye düzeltmesi vardır; bu ayrı bir kayıttır, otomatik iade veya gerçek ödeme değildir (`phase1/core.js`, `phase1/server.js`).
- Cihaz fiyat/pulse, bekleme ve demo LED ayarları sürümlü; işlem ve başlamış bekleme değerleri korunuyor. Uygulama durumu yalnız simülatör raporudur; gerçek cihaz ayar teslimi ve doğrulaması yoktur.
- Yükleme tekrarı API'de idempotent; ana Pug ve simülatör ekranları isteği önce tarayıcıda, sunucuya ulaşınca da kullanıcıya bağlı sunucu niyeti olarak saklar. Yeni doğrudan demo API yüklemeleri de niyet gerektirir; eski kaydedilmiş istekler aynı kullanıcı ve içerikle doğrulanır. İstek sunucuya ulaşmamış ve tarayıcı kaydı kaybolmuşsa kimlik kurtarılamaz. Farklı niyetler bağımsız yükleme yapabilir; tam çift yükleme koruması yoktur.
- Yönetici, bilinen istek kimliğiyle merkezde tamamlanmış demo yüklemeyi salt okunur sorgulayabilir. Kayıt bulunmaması veya tutarsızlık belirsizdir; istek kimliği kaybolursa bu sorgu onu geri getirmez ve otomatik iptal/iade yapmaz.
- Ana ekranda son 25 sunucuda kaydedilmiş demo yükleme istek kimliğiyle görülebilir; personel yalnız kendi kayıtlarını, yönetici tümünü görür. Sunucuya gelmemiş veya tamamlanmamış istekler listelenemez; farklı kimlikle eşzamanlı istekleri tek işlem sayma veya engelleme yoktur.
- Simülatör kart kaldırma ve bekleme mantığı var; kısa RF kopması fiziksel okuyucuda test edilmedi.
- İşlem türleri veri modelinde ayrılabilse de iade ve bonus işlemleri ve raporları uçtan uca tamamlanmadı; ücretsiz oyun yalnız gerekçeli sıfır ücretli demo ile sınırlıdır.
- Ana ekran ve simülatörün HTML/CSS kaynakları için yerel adres ve erişilebilirlik testi var. Chromium'da tarayıcıdan yerel adres dışındaki HTTP istekleri engellenerek sahte hesap/kart, 200 TL yükleme, 50 TL sanal oyun ve 150 TL bakiye akışı geçti; dış istek girişimi görülmedi. Bu yalnız tarayıcı isteği simülasyonudur; sunucu sürecinin ağ erişimi engellenmedi ve gerçek internet kesilerek tam çevrimdışı kabul testi yapılmadı.

## Yapılmayan

- Gerçek okuyucu, GPIO veya fiziksel pulse testleri; Faz 2 kapsamındadır.
- Windows betikleri eklendi; `e9ee02b` için ayrı Windows testinde 48/48 test ve 200/50/150 demo akışı bildirildi. Sonradan eklenen yerel kaynak testi ve görsel düzeltmesi Windows'ta henüz doğrulanmadı.
- Gerçek para işlemleri, iade politikası ve tamamlanmamış Faz 1 kabul testleri; üretime hazırlık iddiası yoktur.
- Gerçek JSON bakiyelerinin dönüştürülmesi; demo ayrı SQLite kullanır.

## Kullanıcı kararı / doğrulama gerektirenler

- Eski `credit` değerlerinin TL'ye dönüşüm kuralı ve gerçek veriye geçiş, kullanıcı kararı ve yedekleme planı gerektirir; dönüşüm yapılmadı.
- Demo düzeltmede gerekçe ile artı/eksi hareket seçimi kullanılır; gerçek düzeltme/iade iş kuralları ve yetki prosedürü kullanıcı onayı gerektirir.
- Donanım panel varyantı, elektriksel çıkış/NO-NC, ticket sinyali ve sahiplik politikası henüz doğrulanmadı; `docs/OPEN_QUESTIONS.md`.
- Ticari dağıtım lisans durumu depodaki bildirimlerle netleştirilmelidir; yeni lisans atanmadı.
