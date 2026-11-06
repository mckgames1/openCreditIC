# İlerleme

Tarih: 2026-11-06  
Branch: `codex/phase1-local-demo-20261106`  
Temel commit: `c96727c2d76d54179b67c1fcc34fc4cb1a8a5466`

## Durum

Faz 1 kabul maddeleri ve açık kararlar: [FAZ1_KABUL.md](FAZ1_KABUL.md).

Faz 1 tamamlanmadı; yerel demo geliştirme aşamasındadır. `npm run phase1` mevcut sunucu girişini demo modunda başlatır, Pug görünümü sunar ve legacy route'ları kaydetmez. Normal `npm start` legacy modudur. Demo veritabanı `phase1-data/demo.sqlite` altında ayrıdır.

`/phase1/home`, mevcut `home.pug` üzerindeki kayıt ve yükleme pencerelerini kullanır: demo hesap ve sanal UID birlikte oluşturulur, kart seçilerek bakiye görüntülenir ve yükleme SQLite API'sine gönderilir. Simülatör ayrı ekranda seçilen kartla çalışır. Bu akış Chromium'da test edildi; diğer eski ana sayfa işlemleri demo modunda uygulanmamıştır.

Mevcut ana sayfada yönetici için makine adı, fiyatı, aktif durumu ve sanal pulse süresi/adedi/aralığı ile toplam yükleme, harcama ve bakiye özeti gösterilir. Chromium'da 200 TL yükleme, 50 TL fiyat ve 150 ms ayarla oyun sonrası 150 TL bakiye doğrulandı; gerçek donanım kullanılmadı.

Personel ana sayfada demo yükleme yapar ve son 25 kendi hareketini görür. İşlem kimliği ve denetim kaydı saklanır; personel genel özet ve diğer komut geçmişini alamaz. Chromium'da personel girişi, yükleme, geçmiş ve yönetici panelinin gizlenmesi doğrulandı. Gerçek kasa okuyucusu ve oturum eşleme Faz 3'tedir.

Yönetici mevcut ana sayfadan demo personel hesabı oluşturabilir ve erişimini durdurup açabilir. Durdurma mevcut oturumları sonlandırır; yeniden açılan hesap eski oturumlarla kullanılamaz. Yönetici kendi parolasını yeniden girerek 10 dakika geçerli tek kullanımlık demo yenileme kodu oluşturabilir; personel kendi yeni parolasını belirlediğinde eski oturumları sona erer. Kodun yalnız özeti saklanır, uygulama kodu dışarı göndermez. Bu değişiklik şema geçişi gerektirmez ve yalnız yerel demo içindir.

Yönetici ana sayfasında son 25 sanal komutun kimliği, cihazı, tutarı ve durumu gösterilir; simülatördeki değişiklikleri yenile düğmesiyle alır. Sunucudaki yetki denetimi korunur ve personel bu kayıtları almaz. Belirsiz durum gerçek kredi veya otomatik iade değildir. 32 Linux testi ve yönetici/personel Chromium akışları geçti. Gerçek donanım, bu sürümde Windows ve interneti fiziksel olarak kesilmiş çalışma henüz doğrulanmadı.

Yöneticiye tarih/tür/cihaz filtreli sayfalı demo hareket geçmişi ve ayrı ayrıntılı CSV eklendi. Tarih aralığı İstanbul günleriyle hesaplanır, CSV 5000 kayıt üstünde hata verir; özet CSV korunur. İşlem sonrası hesap bakiyesi dönem sonu toplamı değildir. Gerçek veriye geçiş, Windows/Excel ve fiziksel donanım doğrulanmadı.

Demo yüklemede bekleyen istek aynı tarayıcı profilinin kalıcı depolamasına gönderimden önce kaydedilir; iki demo ekranı kaydı ortak kullanır. Yanıt kaybı ve tarayıcı/sunucu yeniden başlatması sonrası aynı kullanıcıyla aynı işlem kimliği doğrulanabilir; farklı kullanıcı sunucuda reddedilir. Hatalı veya okunamayan kayıt kendiliğinden silinmez, depolama yazılamazsa yeni istek gönderilmez. Profil temizleme, özel mod, cihaz değişimi ve aynı anda bağımsız yeni işlemler bu mekanizmanın dışında; sunucu tabanlı bekleyen istek kuyruğu veya kullanıcı arayüzünden gerekçeli iptal henüz yoktur.

36 Linux otomatik testi geçti. Chromium kalıcı profiliyle sunucuya ulaşan ancak yanıtı kaybolan yükleme, tarayıcı ve sunucu yeniden başlatma, başka kullanıcının reddi, sunucuya hiç ulaşmayan isteğin diğer demo ekranından doğrulanması ve bozuk kayıtla gönderimin engellenmesi denendi. Windows ve gerçek ağ/donanım test edilmedi.

Yöneticiye bilinen demo yükleme istek kimliğiyle salt okunur merkez kaydı sorgusu eklendi. Bulunan kayıt tutar, kullanıcı ve işlem sonrası hesap bakiyesini gösterir; kayıt yokken veya tutarsızken sonuç bilinmiyor olarak kalır. Sorgu yeni işlem üretmez. Bekleyen ekran yalnız işlemin sahibine istek kimliğini gösterir. İstek kimliğinin başka cihazda kendiliğinden kurtarılması, sunucuya ulaşmamış isteğin merkezi kaydı ve gerçek para desteği yoktur. 37 Linux testi ve Chromium ile kayıtlı/bilinmeyen sorgu doğrulandı.

Tanımsız kartın ücret ve komut üretmemesi, tutulmuş kartın gerçek bekleme süresi geçtikten sonra ikinci ödemeyi reddetmesi ve yeterli süre çekilmiş kartın yeniden ödeme yapabilmesi izole demo HTTP testine eklendi. Son iki durum Chromium simülatöründe de 200 ms ayar ve 300 ms gerçek beklemeyle denendi. Linux'ta 38 otomatik test geçti; gerçek RFID, fiziksel pulse, Windows ve internetin fiziksel kesilmesi test edilmedi.

Yönetici, gerekçe ve hazır/tanımlı/engelsiz sanal kartla sıfır tutarlı ücretsiz demo oyunu oluşturabilir. Bakiye değişmez; işlem kaydı, tek bekleyen sanal komut ve ayrı sayı raporu atomik tutulur. Yanıt kaybında aynı sekmedeki tekrar aynı komutu döndürür; sekme kapanışında bekleyen kimlik korunmaz. Hata enjeksiyonunda işlem/komut geri alındı. Linux'ta 41 otomatik test ile Chromium'da ücretsiz oyun, kayıp yanıt ve yönetici/personel akışları geçti. `0c8a04a` için Windows'ta 38/38 ve 200/50/150 akışı bildirildi; bu sonraki değişiklik Windows'ta doğrulanmadı. Gerçek ücretsiz oyun yetkileri ve iş kuralları kullanıcı kararına açık, gerçek cihaz/para yok.

Yönetici aynı sayfada seçili demo kartı engelleyebilir veya engelini kaldırabilir. Tekrarlanan aynı durum isteği ikinci denetim olayı üretmez; engelli kart ödeme yapamaz. Chromium ve HTTP testleriyle doğrulandı.

Ana sayfada seçili demo hesaba başka sanal UID bağlanabilir; kartlar aynı bakiyeyi paylaşır. Tekrarlanan bağlama isteği aynı sonucu döndürür, UID yeniden farklı hesaba atanmaz. Chromium'da iki kartın ortak bakiyesi ve HTTP testinde yeniden başlatma doğrulandı. Fiziksel okuyucu bağlantısı yoktur.

Yönetici ana sayfada demo makine oluşturup kart çekilme ve ödeme bekleme sürelerini cihaz bazında ayarlayabilir. Sürümler makine ayar sürümüne eklenir; başlamış beklemeler ayar değişikliğiyle kısalmaz. Chromium'da iki cihaz için ayar ve sanal cihaz seçimi; HTTP testinde kısa çekilme, bekleme, sürüm, yetki ve yeniden başlatma doğrulandı.

Cihaz başına demo LED etkinliği ve 0–255 sanal parlaklığı ayarlanabilir. Ayar sürümü sanal okuyucuda bekliyor, uygulandı veya başarısız olarak işaretlenir; eski sürüm raporu reddedilir. Sanal LED son başarılı sanal uygulama değerini gösterir. Ödeme sonucunda işlem anındaki istenen ve sanal uygulanan LED ayarları saklanır. Gerçek LED'e aktarım yapılmaz. Varsayılan 128 yalnız demo değeridir. Mevcut SQLite ayar tablosu kullanılır; bu adım şema geçişi gerektirmez. 25 otomatik test ve Chromium'da sanal uygulama geçti.

Simülatör ekranı bekleme fiyatını, işlem göstergesini, onay tutarı ve bakiyeyi, yetersiz bakiye ve bağlantı kesik durumlarını gösterir. Chromium'da onay, yetersiz bakiye ve yerel bağlantı kesik simülasyonunda bakiye/komutun artmadığı doğrulandı. Bu gerçek ağ kesintisi veya ekran donanımı testi değildir.

Şema 3 geçişi: Mevcut demo veritabanında geçiş öncesi aynı dizine `demo.sqlite.before-v3-<benzersiz>.sqlite` adlı ayrı tutarlı yedek alınır; ortak süreler mevcut cihazlara kopyalanır, eski veriler silinmez. Geçişten önce eski demo sunucusunu durdurun. Eski sürümde başlamış beklemenin özgün ayarı saklanmadığı için geçiş anındaki ortak değer kullanılır. Yedekleme başarısızsa geçiş başlamaz. Eski ortak ayar API'si demo modunda 410 döndürür; yeni ayarlar cihaz yolunda yapılır. Legacy JSON modu bu geçişe dahil değildir.

Ana Pug ve simülatör ekranındaki demo yüklemelerde yanıt kaybı sonrası aynı sekmede sayfa yenilenirse özgün istek kimliği ve içeriğiyle doğrulama yapılır. Chromium'da iki ekranda da sunucu yanıtı kesilerek tek yükleme doğrulandı. Sekme kapatılması veya farklı tarayıcı için bu kurtarma garantisi yoktur.

## Gerçek RFID okuyucu durumu

Mevcut `CardReader-Game/CardReader-Game.ino:327` UID baytlarını baştaki sıfırları her baytta koruyacak şekilde biçimlendirmiyor; `:662` eski `withdraw` yoluna anahtarı URL içinde gönderiyor; `:750` sabit 100 ms fiziksel çıkış örneği içeriyor. `:35` OLED sürücüsüdür. Bu firmware yeni demo ödeme/komut akışına bağlanmış veya donanımda doğrulanmış değildir. RC522/ESP32 bağlantısı, cihaz kimliği ve güvenli haberleşme, gerçek pulse davranışı ve elektriksel testler Faz 2'de ayrıca ele alınmalıdır. 1,69 inç 240×280 ekran adayının sürücüsü doğrulanmamıştır; kesin panel veya pin seçimi yapılmadı.

## Test kanıtı

Demo yöneticisi ana Pug sayfasında seçili hesaba gerekçeli artı/eksi düzeltme yapabilir. Bu bir demo varsayımıdır; iade veya gerçek tahsilat değildir. Eski hareketler korunur, düzeltme ve denetim kaydı ayrıdır. Tekrar kimliği ve negatif bakiye kontrolü test edildi; Chromium'da 12,34 TL düşüm ve ayrı özet doğrulandı.

`npm test` sonucu: **25 test geçti, 0 başarısız**. İki bağımsız süreç ve SQLite bağlantısı, iki sanal cihazın 25 TL bakiyeden 25 TL talebini yarış koşulunda çalıştırdı: ikinci bağlantının kilidi beklediği, tek düşüm ve tek komut, her iki isteğin tekrarı ve SQLite bütünlüğü doğrulandı. Bu çekirdek düzeyi testtir; gerçek iki okuyucu testi değildir. Yarış testi ayrıca beş kez geçti. Şema 2'den geçiş öncesi yedek, iki cihazın farklı süreleri ve yeniden başlatma test edildi. Canlı WAL yedek ve yeni dosyaya geri yükleme test edildi. Ödeme transaction'ında süreç SIGKILL ile durdurularak yeniden açma ve tekrar test edildi. Yönetici inceleme yetkisi, çoklu kart, kart engeli, süreler, fiyat/pulse sınırları, personel erişimi, geçmişi ve kalıcılık test edildi. Chromium'da ödeme yanıtı kaybı ve tekrar test edildi; inceleme ekranı henüz tarayıcıda test edilmedi.

Kapsanan akışlar: 200 TL yükleme, 25 TL ödeme, tekrar istek, bağımsız süreçlerden eşzamanlı iki sanal cihaz isteği, kartı tutarken tekrar yaklaştırma, yetersiz bakiye, demo modunda eski yolların reddi, legacy modunda bir route'un varlığı, fiyat snapshot'ı, yeniden açılışta kalıcılık ve personel API yetki reddi.

Bağımlılık kurulumu `NPM_CONFIG_CACHE=/tmp/opencreditic-npm-cache npm ci` ile tamamlandı. Node.js `v24.22.1`; paket gereksinimi `>=22.5.0` çünkü Faz 1 yerleşik `node:sqlite` kullanır.

## Çalıştırma

Windows için `KURULUM.bat`, `BASLAT.bat`, `TEST.bat` eklendi; Node/SQLite/bağımlılık kontrolleri ve hata mesajları içerir. Windows yerel testinden 18/18 sonucu ve test uyumluluğu düzeltmeleri bildirildi; bu ortamda Windows testi tekrar edilmedi. Test dosyaları platformlar arası Node test başlatıcısıyla seçilir.

```text
npm ci
npm run phase1
```

Tarayıcı: `http://127.0.0.1:1787/phase1`  
`npm start` legacy JSON modunu açar, demo ekranını sunmaz ve tüm ağ arayüzlerini dinler.

Yedek:

```text
npm run phase1:backup -- --output phase1-backups/demo-copy.sqlite
npm run phase1:restore -- --source phase1-backups/demo-copy.sqlite --output phase1-backups/restored-check.sqlite
```

Yedekleme çalışan SQLite veritabanından tutarlı anlık görüntü alır. Geri yükleme sadece yeni dosyaya yapılır; mevcut veritabanını değiştirmez. Hedef veya SQLite yan dosyası varsa işlem reddedilir. Hata sırasında ayrılmış boş veya eksik hedef dosyası kalabilir; otomatik silinmez, doğrulanmadan kullanılmamalıdır. Geri yüklenen kopyayı ayrı ortamda doğrulayın; çalışan veritabanını değiştirmeyin. Gerçek `cards.json` veya `history.json` otomatik aktarılmaz.

## Sınırlar

Gerçek RFID, ESP32, TFT, LED, ticket hattı, GPIO, fiziksel pulse, POS, bulut ve internetten erişim doğrulanmadı. Belirsiz komut `ambiguous` durumunda kalır; yönetici karar ve gerekçesi ayrı kaydedilir. Gerçek iade ve düzeltme politikası onaylı değildir. Gerçek fiziksel pulse sonucu atomik olarak garanti edilemez. Çift tıklamalı yükleme, gerçek okuyucu eşzamanlılığı ve çevrimdışı ağ testleri eksiktir. “Üretime hazır” iddiası yoktur.
