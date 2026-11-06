# Demo yükleme uzlaşması: durum ve sonraki tasarım

## Bugün çalışan küçük adım

Ana Pug ekranında sunucunun kaydettiği son 25 demo yükleme listelenir. Personel yalnız kendi kayıtlarını; yönetici tüm kullanıcıların kayıtlarını görür. İstek kimliği, zaman, tutar ve kullanıcı kayıtları karşılaştırmaya yardımcıdır. Liste salt okunurdur; işlem yapmaz, iptal etmez ve iade oluşturmaz. Liste yalnız başarıyla merkezde kaydedilmiş işlemleri gösterebilir; görünmeyen bir istek başarısız veya hiç gelmemiş sayılmaz. Aynı tutar ve zaman, iki kaydın aynı iş niyeti olduğunun kanıtı değildir.

Demo arayüzü işlemden önce kullanıcıya bağlı niyeti sunucuya kaydeder; açık niyetler aynı kullanıcıya farklı tarayıcı profilinde gösterilebilir ve kullanıcı tarafından aynı kimlikle tamamlanabilir. Niyetin tamamlanması, bakiye hareketi ve idempotans kaydı aynı SQLite transaction'ında yazılır. Aynı kimlik ve içerik tekrarı ikinci yükleme yapmaz. Ayrı niyetler aynı tutarda olsa bile meşru ayrı işlemler olabileceği için otomatik engellenmez. Farklı kimlikle iki istek eşzamanlı gönderilirse ikisi de kaydedilebilir. Mevcut doğrudan demo `/api/topups` yolu uyumluluk için hâlâ kullanılabilir ve niyet hazırlama adımını zorunlu kılmaz; dolayısıyla tüm girişlerde güvenli uzlaşma sağlandığı iddia edilemez. Demo sunucusu yalnız localhost üzerindedir; bu adım başka bilgisayardan bağlantıyı açmaz.

## Durum ve sonraki tasarım

1. **Demo arayüzünde uygulandı:** Yüklemeden önce sunucuda kullanıcıya bağlı benzersiz bir niyet kaydedilir; aynı kullanıcı açık niyetlerini sorgulayabilir. Niyet sunucuya hiç ulaşmamışsa listede görünmez ve sonuç yine bilinmez.
2. **Demo niyet yolunda uygulandı:** Niyetin yürütülmesi, bakiye kaydı ve kesinleşmiş sonuç aynı transaction'dadır. Tekrar aynı niyet kimliğini ve içeriği kullanır; farklı içerik reddedilir. Yetki sunucuda doğrulanır.
3. **Açık:** Açık niyetleri farklı yeni kimliklerle aşmaya karşı bütün demo yükleme girişleri ortak kurallara tabi olmalıdır. Bir kullanıcının çözülmemiş niyeti varken yeni niyetin engellenmesi gibi politika kullanıcıyla netleştirilir; farklı kullanıcıların aynı tutardaki işlemleri otomatik olarak aynı sayılmaz.
4. Sunucuda niyet bulunmaması, ilk isteğin hiç ulaşmadığını kanıtlamaz: istek yolda veya yanıt kaybolmuş olabilir. Bu durumda otomatik iptal, iade, başarı veya farklı kimlikle yeniden yükleme yapılmaz; durum açıkça inceleme gerektirir.
5. **Kısmi:** Niyetler mevcut SQLite ayar tablosunda saklanır; şema geçişi yoktur. Aynı niyette iki bağımsız süreç yarışı, çökme, yetki ve farklı tarayıcı profilleri demo testlerinden geçti. Farklı niyetler ve doğrudan eski demo API'si hâlâ ek kontrol gerektirir; gerçek kullanıma geçilmez.

İşletmedeki nakit alındı bilgisi, iptal yetkisi, bekleme süresi, personeller arası devralma ve aynı hesaba meşru art arda yükleme kuralları henüz kullanıcı kararı gerektirir. Gerçek para veya fiziksel cihaz kullanılmaz.
