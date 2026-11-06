@echo off
setlocal
cd /d "%~dp0"
echo openCreditIC - Demo testleri
where node >nul 2>&1
if errorlevel 1 goto missingnode
where npm.cmd >nul 2>&1
if errorlevel 1 goto missingnpm
node phase1\scripts\check-runtime.js --dependencies
if errorlevel 1 goto failed
call npm.cmd test
if errorlevel 1 goto testfailed
echo Testler tamamlandi.
pause
exit /b 0
:missingnode
echo HATA: Node.js bulunamadi. KURULUM.bat ile on kosullari kontrol edin.
goto failed
:missingnpm
echo HATA: npm bulunamadi. Node.js ve PATH ayarlarini kontrol edin.
goto failed
:testfailed
echo HATA: Bir veya daha fazla test basarisiz. Yukaridaki sonucu kontrol edin.
:failed
pause
exit /b 1
