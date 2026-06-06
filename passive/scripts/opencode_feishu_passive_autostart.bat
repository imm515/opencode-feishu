@echo off
setlocal EnableExtensions
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0opencode_feishu_passive_ctl.ps1" auto
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0opencode_feishu_passive_ctl.ps1" auto
)
