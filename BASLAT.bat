@echo off
setlocal
cd /d "%~dp0"
echo openCreditIC - Yerel demo, gercek donanim degil
where node >nul 2>&1
if errorlevel 1 goto missingnode
where npm.cmd >nul 2>&1
if errorlevel 1 goto missingnpm
node phase1\scripts\check-runtime.js --dependencies
if errorlevel 1 goto failed
set "PHASE1_DB_PATH=%~dp0phase1-data\demo.sqlite"
set "PHASE1_PORT=1787"
echo Tarayicida http://127.0.0.1:1787/phase1/home adresini acin.
echo Durdurmak icin bu pencerede Ctrl+C tuslarina basin.
call npm.cmd run phase1
if errorlevel 1 goto startfailed
exit /b 0
:missingnode
echo HATA: Node.js bulunamadi. KURULUM.bat ile on kosullari kontrol edin.
goto failed
:missingnpm
echo HATA: npm bulunamadi. Node.js ve PATH ayarlarini kontrol edin.
goto failed
:startfailed
echo HATA: Demo baslatilamadi veya beklenmedik bicimde durdu.
echo Yukaridaki hata mesajini kontrol edin; 1787 portu kullanimda olabilir.
:failed
pause
exit /b 1
