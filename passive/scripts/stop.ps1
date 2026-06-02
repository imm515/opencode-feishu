# opencode-feishu passive monitor — stop daemon
# Reads .passive.pid, sends graceful SIGTERM via Stop-Process, falls back to /F.

$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot  = Resolve-Path (Join-Path $scriptRoot "..")
$pidFile      = Join-Path $passiveRoot ".passive.pid"

$procId = Get-Content $pidFile -ErrorAction SilentlyContinue
if (-not $procId) {
    Write-Host "[skip] no .passive.pid — daemon not running"
    exit 0
}

$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "[stale] PID $procId not alive — removing pidfile"
    Remove-Item $pidFile -Force
    exit 0
}

if ($proc.ProcessName -ne "node") {
    Write-Host "[mismatch] PID $procId is $($proc.ProcessName), not node — removing pidfile"
    Remove-Item $pidFile -Force
    exit 0
}

Write-Host "[stop] sending graceful stop to PID $procId (started $($proc.StartTime))"
try {
    Stop-Process -Id $procId -ErrorAction Stop
} catch {
    Write-Host "[warn] graceful stop failed: $_ — forcing"
    Stop-Process -Id $procId -Force
}

$waited = 0
while ($waited -lt 10) {
    Start-Sleep -Seconds 1
    $waited++
    $still = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $still) { break }
}
if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
    Write-Host "[force] still alive after ${waited}s — sending /F"
    Stop-Process -Id $procId -Force
} else {
    Write-Host "[ok] PID $procId stopped after ${waited}s"
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
exit 0

