@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo          HAMU STRIKE - GAME SERVER
echo ==========================================
echo.
echo Starting local game server on port 8137...
echo.

where py >nul 2>&1
if %errorlevel%==0 (
    start "HAMU STRIKE SERVER" /min cmd /c "cd /d ""%~dp0"" && py -m http.server 8137"
) else (
    where python >nul 2>&1
    if %errorlevel%==0 (
        start "HAMU STRIKE SERVER" /min cmd /c "cd /d ""%~dp0"" && python -m http.server 8137"
    ) else (
        echo Python was not found on this PC.
        echo Please install Python 3 or run the game with another local web server.
        pause
        exit /b 1
    )
)

timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8137/index.html"

echo.
echo Game opened in your browser.
echo Keep the HAMU STRIKE SERVER window running while playing.
echo You can close this window when finished.
timeout /t 3 /nobreak >nul
exit /b 0
