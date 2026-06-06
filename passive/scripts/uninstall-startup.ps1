$taskName = "OpenCodeFeishuPassive"
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$shortcutPath = Join-Path $startupDir 'OpenCodeFeishuPassive.lnk'

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    try {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
        Write-Host "[ok] task '$taskName' unregistered"
    } catch {
        Write-Host "[warn] could not remove task '$taskName': $($_.Exception.Message)"
    }
}

if (Test-Path $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "[ok] removed $shortcutPath"
}
