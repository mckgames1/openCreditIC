# openCreditIC çalışma kuralları

- Mevcut `card-server.js`, Pug arayüzü, JSON uyumluluk akışı ve ESP32 kaynaklarını silme veya sessizce yeniden yazma.
- Faz 1 demo verisi yalnızca `phase1-data/` altında SQLite ile çalışır; gerçek `cards.json`/`history.json` verisine migration uygulanmaz.
- Para kuruş cinsinden tam sayı tutulur. Yeni ödeme ve yükleme API'leri idempotency anahtarı kullanır.
- Demo varsayılan olarak yalnızca localhost'a bağlanır; gerçek GPIO, RFID, pulse, ticket veya uzak internet akışı yoktur.
- Donanım ve ticari kullanım kararlarını kesinleşmiş gibi yazma; açık noktaları `docs/OPEN_QUESTIONS.md` içinde tut.
- Değişiklik öncesi `git status` kontrol et; mevcut kullanıcı değişikliklerini koru.

Belge ve kapsam referansları:

- [Proje şartnamesi](docs/PROJECT_SPEC.md)
- [Depo denetimi](docs/REPO_AUDIT.md)
- [Faz planı](docs/PLAN.md)
- [Açık sorular](docs/OPEN_QUESTIONS.md)
- [İlerleme ve test kanıtı](docs/PROGRESS.md)
