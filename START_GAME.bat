@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ============================================================
REM HAMU STRIKE - LOCAL GAME LAUNCHER
REM ============================================================

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "PORT=8137"

REM IMPORTANT: if this BAT is double-clicked while still INSIDE a ZIP/RAR,
REM Windows/WinRAR may execute a temporary copy. That copy does not contain
REM the complete game, so index.html/assets cannot be served from it.
echo "%ROOT%" | findstr /I /C:"\AppData\Local\Temp\Rar$" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo ============================================================
    echo [ERROR] GAME IS BEING RUN FROM WINRAR TEMPORARY FOLDER
    echo ============================================================
    echo.
    echo You double-clicked START_GAME.bat while the ZIP was still open
    echo in WinRAR. Windows is running a temporary copy from:
    echo.
    echo "%ROOT%"
    echo.
    echo FIX:
    echo 1. Close this window.
    echo 2. In WinRAR click ^"Extract To^".
    echo 3. Extract the ENTIRE Chats-s-main folder to Desktop or Documents.
    echo 4. Open the extracted Chats-s-main folder in Windows Explorer.
    echo 5. Double-click START_GAME.bat THERE.
    echo.
    echo Do NOT double-click START_GAME.bat from inside WinRAR.
    echo ============================================================
    echo.
    pause
    exit /b 1
)

cd /d "%ROOT%"

if not exist "%ROOT%\index.html" (
    echo.
    echo [ERROR] index.html was not found in:
    echo "%ROOT%"
    echo.
    echo Make sure START_GAME.bat is in the same folder as index.html.
    echo If using the GitHub ZIP, extract the complete ZIP first.
    pause
    exit /b 1
)

if not exist "%ROOT%\game.js" (
    echo.
    echo [ERROR] game.js was not found in:
    echo "%ROOT%"
    pause
    exit /b 1
)

if not exist "%ROOT%\assets" (
    echo.
    echo [ERROR] assets folder was not found in:
    echo "%ROOT%"
    pause
    exit /b 1
)

REM Clear variables that can make Python resolve its standard library
REM from an unrelated/broken Python installation.
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
    echo Install Python 3 and run START_GAME.bat again.
    pause
    exit /b 1
)

REM Stop an old server listening on our game port so it cannot serve a
REM different folder/version of the game.
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
echo [OK] index.html
if exist "%ROOT%\assets\models\csmap.glb" (
    echo [OK] assets\models\csmap.glb
) else (
    echo [WARNING] assets\models\csmap.glb not found
)
echo.
echo Starting server on %URL%
echo.

REM Explicitly serve the actual extracted game directory.
start "HAMU STRIKE SERVER" /min "%PYTHON%" -m http.server %PORT% --bind 127.0.0.1 --directory "%ROOT%"

timeout /t 2 /nobreak >nul

REM Confirm the server is listening before opening the browser.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if(-not $c){exit 1}" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] The local HTTP server did not start.
    echo Python command: %PYTHON%
    echo Game root: "%ROOT%"
    pause
    exit /b 1
)

start "" "%URL%"

echo [OK] Server is running.
echo [OK] Game opened in your browser.
echo.
exit /b 0
