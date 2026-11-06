# Uygulama planı

## Faz 1 — mevcut branch

Branch: `codex/phase1-local-demo-20261106`  
Temel commit: `c96727c2d76d54179b67c1fcc34fc4cb1a8a5466`

Tamamlananlar:

1. Depo ve upstream durumu denetlendi.
2. SQLite migration şeması ve demo seed verisi eklendi.
3. Admin/staff oturum ve yetki kontrolleri eklendi.
4. Kuruş bazlı top-up, oyun harcaması, idempotency ve pulse komut günlüğü eklendi.
5. Kart simülatörü, cihaz ekran oranı ve LED durumu eklendi.
6. Eski Express sunucusuna `/phase1` mount edildi; ayrı `npm run phase1` komutu hazırlandı.
7. Otomatik çekirdek ve HTTP testleri eklendi.

## Sıradaki tek adım

Faz 1'de ödeme ve simülatör durumunun çökme güvenliğini, eşzamanlılığı ve belirsiz komut incelemesini tamamlayıp eksik kabul testlerini çalıştırmak. Faz 2 henüz başlamaz.

## Sonraki fazlar

Faz 3: POS/kasa okuyucusu ve müşteri kiosku.  
Faz 4: Sinyal ve sahip geçişi doğrulanınca e-ticket.  
Faz 5: raporların genişletilmesi, uzaktan yönetim ve kontrollü bulut senkronizasyonu.
