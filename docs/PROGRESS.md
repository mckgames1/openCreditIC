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

Yönetici mevcut ana sayfadan demo personel hesabı oluşturabilir. Chromium'da hesap oluşturma, parola alanının temizlenmesi, personel girişi ve demo yükleme doğrulandı. Personel hesap kapatma veya parola sıfırlama ekranı henüz yoktur.

Ana Pug ekranındaki demo yüklemede yanıt kaybı sonrası aynı sekmede sayfa yenilenirse özgün istek kimliği ve içeriğiyle doğrulama yapılır; Chromium'da sunucu yanıtı kesilerek tek 37 TL yükleme doğrulandı. Sekme kapatılması, farklı tarayıcı veya diğer demo yükleme ekranı için bu kurtarma garantisi yoktur.

## Test kanıtı

Demo yöneticisi ana Pug sayfasında seçili hesaba gerekçeli artı/eksi düzeltme yapabilir. Bu bir demo varsayımıdır; iade veya gerçek tahsilat değildir. Eski hareketler korunur, düzeltme ve denetim kaydı ayrıdır. Tekrar kimliği ve negatif bakiye kontrolü test edildi; Chromium'da 12,34 TL düşüm ve ayrı özet doğrulandı.

`npm test` sonucu: **19 test geçti, 0 başarısız**. İki bağımsız süreç ve SQLite bağlantısı, iki sanal cihazın 25 TL bakiyeden 25 TL talebini yarış koşulunda çalıştırdı: ikinci bağlantının kilidi beklediği, tek düşüm ve tek komut, her iki isteğin tekrarı ve SQLite bütünlüğü doğrulandı. Bu çekirdek düzeyi testtir; gerçek iki okuyucu veya iki simülatör oturumu testi değildir. Yarış testi ayrıca beş kez geçti. Canlı WAL yedek ve yeni dosyaya geri yükleme test edildi. Ödeme transaction'ında bakiye güncellemesinden sonra, commit öncesinde ve commit sonrasında süreç SIGKILL ile durdurularak yeniden açma ve tekrar test edildi. Yönetici inceleme yetkisi, fiyat/pulse sınırları, personel geçmişi ve kalıcılık test edildi. Chromium'da ödeme yanıtı kaybı ve tekrar test edildi; inceleme ekranı henüz tarayıcıda test edilmedi.

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
