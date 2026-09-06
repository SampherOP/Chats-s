@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ============================================================
REM HAMU STRIKE - LOCAL GAME LAUNCHER
REM This BAT always serves the folder containing this BAT.
REM ============================================================

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "PORT=8137"

cd /d "%ROOT%"

if not exist "%ROOT%\index.html" (
    echo.
    echo [ERROR] index.html was not found.
    echo This BAT must be inside the main game folder.
    echo.
    echo Current folder: "%ROOT%"
    pause
    exit /b 1
)

if not exist "%ROOT%\game.js" (
    echo.
    echo [ERROR] game.js was not found.
    echo Current folder: "%ROOT%"
    pause
    exit /b 1
)

if not exist "%ROOT%\assets" (
    echo.
    echo [ERROR] assets folder was not found.
    echo Current folder: "%ROOT%"
    pause
    exit /b 1
)

REM Find Python. Clear variables that can make Python resolve its
REM standard library from an unrelated installation.
set "PYTHONHOME="
set "PYTHONPATH="
set "PYTHON="

where py.exe >nul 2>&1
if not errorlevel 1 set "PYTHON=py.exe"

if not defined PYTHON (
    where python.exe >nul 2>&1
    if not errorlevel 1 set "PYTHON=python.exe"
)

if not defined PYTHON (
    echo.
    echo [ERROR] Python 3 was not found on this PC.
    echo Install Python 3, then run START_GAME.bat again.
    echo.
    pause
    exit /b 1
)

REM Stop only Python processes currently listening on our game port.
REM This prevents an older server from keeping the browser on a stale root.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if($c){$pids=$c.OwningProcess | Sort-Object -Unique; foreach($p in $pids){try{Stop-Process -Id $p -Force -ErrorAction Stop}catch{}}}" >nul 2>&1

timeout /t 1 /nobreak >nul

set "URL=http://127.0.0.1:%PORT%/index.html"

echo ==========================================
echo          HAMU STRIKE - GAME SERVER
echo ==========================================
echo.
echo GAME ROOT:
echo "%ROOT%"
echo.
echo Checking required files...
echo [OK] index.html
echo [OK] game.js
echo [OK] assets\
echo.
echo Starting server on %URL%
echo.

REM IMPORTANT: use START directly with Python and an explicit directory.
REM No nested CMD /C quoting is used, avoiding the previous 404 problem.
start "HAMU STRIKE SERVER" /min "%PYTHON%" -m http.server %PORT% --bind 127.0.0.1 --directory "%ROOT%"

timeout /t 2 /nobreak >nul

REM Confirm the port is actually listening before opening Chrome.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if(-not $c){exit 1}" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] The local HTTP server did not start.
    echo.
    echo Python command used: %PYTHON%
    echo Game root: "%ROOT%"
    echo.
    echo Run START_GAME.bat from a Command Prompt to see the error.
    pause
    exit /b 1
)

start "" "%URL%"

echo [OK] Server is running.
echo [OK] Game opened in your browser.
echo.
echo Keep the server window open while playing.
echo.
exit /b 0
