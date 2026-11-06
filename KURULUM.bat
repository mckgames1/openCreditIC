@echo off
setlocal
cd /d "%~dp0"
echo openCreditIC - Demo kurulumu
where node >nul 2>&1
if errorlevel 1 goto missingnode
where npm.cmd >nul 2>&1
if errorlevel 1 goto missingnpm
node phase1\scripts\check-runtime.js
if errorlevel 1 goto failed
if exist node_modules goto existing
if not exist package-lock.json goto missinglock
echo Kilit dosyasindaki paketler kuruluyor. Internet gerekir.
call npm.cmd ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto installfailed
node phase1\scripts\check-runtime.js --dependencies
if errorlevel 1 goto failed
echo Kurulum tamamlandi. BASLAT.bat ile demoyu acabilirsiniz.
pause
exit /b 0
:existing
echo node_modules zaten var; mevcut dosyalar korunuyor ve kurulum yinelenmiyor.
node phase1\scripts\check-runtime.js --dependencies
if errorlevel 1 goto failed
echo Gerekli paketler bulundu. BASLAT.bat ile demoyu acabilirsiniz.
pause
exit /b 0
:missingnode
echo HATA: Node.js bulunamadi. Node.js 22.5 veya ustunu kurup yeniden deneyin.
goto failed
:missingnpm
echo HATA: npm bulunamadi. Node.js kurulumunu ve PATH ayarini kontrol edin.
goto failed
:missinglock
echo HATA: package-lock.json bulunamadi. Proje dosyalarini kontrol edin.
goto failed
:installfailed
echo HATA: Paket kurulumu basarisiz. Internet baglantisini ve hata mesajini kontrol edin.
echo Olusmus node_modules otomatik silinmez veya uzerine yazilmaz.
:failed
echo Islem tamamlanamadi.
pause
exit /b 1
