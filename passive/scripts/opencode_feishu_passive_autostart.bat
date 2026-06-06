@echo off
setlocal
echo.
echo  OpenCode Feishu Passive Daemon AutoStart
echo  ==========================================
echo.
ping 127.0.0.1 -n 11 >nul
echo.
echo  Starting passive daemon...
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0opencode_feishu_passive_autostart.ps1" -AutoStart
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0opencode_feishu_passive_autostart.ps1" -AutoStart
)

echo.
ping 127.0.0.1 -n 4 >nul
