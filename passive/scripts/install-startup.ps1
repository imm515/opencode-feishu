$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot  = Resolve-Path (Join-Path $scriptRoot "..")
$startupDir   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$shortcutPath = Join-Path $startupDir 'OpenCodeFeishuPassive.lnk'
$taskName = "OpenCodeFeishuPassive"

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[replace] removing existing legacy task '$taskName'"
    try {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
        Write-Host "[ok] task '$taskName' unregistered"
    } catch {
        Write-Host "[warn] could not remove legacy task '$taskName': $($_.Exception.Message)"
    }
}

if (-not (Test-Path $startupDir)) {
    New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
$pwshPath = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwshPath) {
    $pwshPath = 'powershell.exe'
}
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'C:\Windows\System32\cmd.exe'
$shortcut.Arguments = '/c chcp 65001 >nul && "' + $pwshPath + '" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "D:\Program Files Dev\opencode-feishu\passive\scripts\opencode_feishu_passive_ctl.ps1" auto'
$shortcut.WorkingDirectory = $passiveRoot
$shortcut.IconLocation = 'C:\Windows\System32\cmd.exe,0'
$shortcut.Description = 'OpenCode Feishu Passive Control'
$shortcut.Save()

Write-Host "[ok] startup shortcut installed: $shortcutPath"
