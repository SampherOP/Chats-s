@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"

echo ==========================================
echo          HAMU STRIKE - GAME SERVER
echo ==========================================
echo.
echo Game folder:
echo %ROOT%
echo.
echo Starting local game server on port 8137...
echo.

where py >nul 2>&1
if not errorlevel 1 (
    set "PYTHON=py"
) else (
    where python >nul 2>&1
    if not errorlevel 1 (
        set "PYTHON=python"
    ) else (
        echo Python 3 was not found on this PC.
        echo Install Python 3 and run START_GAME.bat again.
        pause
        exit /b 1
    )
)

REM IMPORTANT:
REM --directory forces Python's HTTP server to serve this exact repo folder.
REM This prevents 404 errors when START_GAME.bat is launched from another folder.
start "HAMU STRIKE SERVER" /min cmd /d /c ""%PYTHON%" -m http.server 8137 --bind 127.0.0.1 --directory "%ROOT%""

timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8137/index.html"

echo.
echo Game opened in Chrome/default browser.
echo Keep the HAMU STRIKE SERVER window running while playing.
echo.
timeout /t 3 /nobreak >nul
exit /b 0
