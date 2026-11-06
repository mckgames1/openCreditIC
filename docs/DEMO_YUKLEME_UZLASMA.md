# Demo yükleme uzlaşması: durum ve sonraki tasarım

## Bugün çalışan küçük adım

Ana Pug ekranında sunucunun kaydettiği son 25 demo yükleme listelenir. Personel yalnız kendi kayıtlarını; yönetici tüm kullanıcıların kayıtlarını görür. İstek kimliği, zaman, tutar ve kullanıcı kayıtları karşılaştırmaya yardımcıdır. Liste salt okunurdur; işlem yapmaz, iptal etmez ve iade oluşturmaz. Liste yalnız başarıyla merkezde kaydedilmiş işlemleri gösterebilir; görünmeyen bir istek başarısız veya hiç gelmemiş sayılmaz. Aynı tutar ve zaman, iki kaydın aynı iş niyeti olduğunun kanıtı değildir.

Bugünkü işlem kimliği tarayıcı profilinde saklanır. Aynı kimlik ve içerik, işlemi başlatan kullanıcı tarafından tekrarlanırsa sunucu ikinci yükleme yapmaz. Farklı kimlikle iki istek ayrı işlemdir; eşzamanlı gönderilirse ikisi de kaydedilebilir. Ana sayfadaki uyarı, otomatik engelleme veya tam güvence değildir. Demo sunucusu yalnız localhost üzerindedir; bu adım başka bilgisayardan bağlantıyı açmaz.

## Sonraki adım için tasarım önerisi — henüz uygulanmadı

1. Yüklemeden önce sunucuda kullanıcıya bağlı, benzersiz ve kalıcı bir demo işlem niyeti kaydedilir; kayıt yazma atomik ve tekrar edilebilir olmalıdır. İstemci, sunucu yanıtını kaybetse de yetkili kullanıcı kendi açık niyetlerini sorgulayabilir.
2. Aynı niyetin yürütülmesi, bakiye kaydı ve kesinleşmiş sonuç aynı veritabanı transaction'ında olur. Her tekrar aynı niyet/istek kimliğini ve aynı içeriği kullanır; farklı içerik reddedilir. Yetki sunucuda doğrulanır.
3. Açık niyetleri farklı yeni kimliklerle aşmaya karşı bütün demo yükleme girişleri ortak kurallara tabi olur. Bir kullanıcının çözülmemiş niyeti varken yeni niyetin engellenmesi gibi politika kullanıcıyla netleştirilir; farklı kullanıcıların aynı tutardaki işlemleri otomatik olarak aynı sayılmaz.
4. Sunucuda niyet bulunmaması, ilk isteğin hiç ulaşmadığını kanıtlamaz: istek yolda veya yanıt kaybolmuş olabilir. Bu durumda otomatik iptal, iade, başarı veya farklı kimlikle yeniden yükleme yapılmaz; durum açıkça inceleme gerektirir.
5. Yedekli ve geri alınabilir şema geçişi, aynı/farklı kimlikli bağımsız süreç yarışı, sunucu çökmesi, yetki, yanıt kaybı ve farklı tarayıcı/profil testleri tamamlanmadan gerçek kullanıma geçilmez.

İşletmedeki nakit alındı bilgisi, iptal yetkisi, bekleme süresi, personeller arası devralma ve aynı hesaba meşru art arda yükleme kuralları henüz kullanıcı kararı gerektirir. Gerçek para veya fiziksel cihaz kullanılmaz.
