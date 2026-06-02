# opencode-feishu passive monitor — install Windows Task Scheduler entry
# Triggers at user logon, restarts on failure (3x with 1-min intervals).

$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot  = Resolve-Path (Join-Path $scriptRoot "..")
$startScript  = Join-Path $scriptRoot "start.ps1"
$pwshPath     = (Get-Command pwsh.exe -ErrorAction SilentlyContinue)?.Source
if (-not $pwshPath) {
    $pwshPath = "C:\Program Files\PowerShell\7\pwsh.exe"
    if (-not (Test-Path $pwshPath)) {
        $pwshPath = "powershell.exe"
    }
}

$taskName = "OpenCodeFeishuPassive"

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[replace] removing existing task '$taskName'"
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute $pwshPath `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`"" `
    -WorkingDirectory $passiveRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "OpenCode Feishu passive monitor — polls opencode.db every 20s and pushes state transition cards to Feishu chat oc_82bb66a73329cf403644debd24c86ec5" `
    | Out-Null

Write-Host "[ok] task '$taskName' registered"
Write-Host "  trigger : AtLogOn (user $env:USERNAME)"
Write-Host "  action  : $pwshPath -File $startScript"
Write-Host "  restart : up to 5x with 1-min interval on failure"
Write-Host ""
Write-Host "To test now: pwsh -File `"$startScript`""
Write-Host "To remove:   pwsh -File `"$($MyInvocation.MyCommand.Path -replace 'install','uninstall')`""
