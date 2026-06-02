@echo off
setlocal EnableExtensions
title OpenCode Feishu Passive Daemon
cd /d "%~dp0.."

echo.
echo  OpenCode Feishu Passive Daemon AutoStart
echo  ==========================================
echo.

call :countdown 10
if errorlevel 1 exit /b 1

echo.
echo  Starting passive daemon...
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
    pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\start.ps1"
) else (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\start.ps1"
)
echo.
echo  [DONE]
timeout /t 3 /nobreak >nul
goto :eof

:countdown
set /a _sec = %1
echo  Starting in %_sec% seconds...
echo  (Ctrl+C to cancel)
for /l %%i in (%_sec%,-1,1) do (
    ping 127.0.0.1 -n 2 >nul
    set /a _remaining = %%i - 1
    if %%i gtr 9 (
        <nul set /p "=[%%i] "
    ) else (
        <nul set /p "=[ %%i] "
    )
)
echo.
echo.
goto :eof
