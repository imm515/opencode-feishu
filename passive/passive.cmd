@echo off
REM opencode-feishu passive monitor — convenience wrapper for cmd users
REM Use the .ps1 scripts directly for full control.

setlocal
set "SCRIPT_DIR=%~dp0scripts"
if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" goto :no_powershell
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\%~1.ps1" %~2 %~3 %~4 %~5 %~6 %~7 %~8 %~9
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\%~1.ps1" %~2 %~3 %~4 %~5 %~6 %~7 %~8 %~9
)
exit /b %ERRORLEVEL%
:no_powershell
echo [error] PowerShell not found
exit /b 1
