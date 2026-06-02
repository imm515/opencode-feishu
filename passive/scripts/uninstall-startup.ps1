# opencode-feishu passive monitor — uninstall Windows Task Scheduler entry

$taskName = "OpenCodeFeishuPassive"

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "[skip] task '$taskName' not registered"
    exit 0
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "[ok] task '$taskName' unregistered"
