# opencode-feishu passive monitor — start / restart daemon
# Usage:
#   start.ps1                  start (idempotent)
#   start.ps1 -Action restart  kill existing, then start
#   start.ps1 -Action stop     kill existing only
#   start.ps1 -Action status   print current state
#
# Uses tsx to run TypeScript directly (no build step needed).
# Idempotent: if already running, prints existing PID and exits 0.

param(
    [ValidateSet("start", "restart", "stop", "status")]
    [string]$Action = "start"
)

$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot  = Resolve-Path (Join-Path $scriptRoot "..")
$srcEntry     = Join-Path $passiveRoot "src\index.ts"
$logDir       = Join-Path $passiveRoot "logs"
$pidFile      = Join-Path $passiveRoot ".passive.pid"
$outLog       = Join-Path $logDir "passive.out.log"
$errLog       = Join-Path $logDir "passive.err.log"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# --- Helpers for stop / status ---
function Stop-AllDaemons {
    $pids = Find-AllDaemonPids
    if ($pids.Count -eq 0) {
        Write-Host "[stop] no daemon running"
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        return
    }
    foreach ($p in $pids) {
        Write-Host "[stop] killing PID $p"
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
    # Wait up to 5s for processes to exit
    for ($i = 0; $i -lt 10; $i++) {
        $alive = $pids | Where-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue) -ne $null }
        if (-not $alive) { break }
        Start-Sleep -Milliseconds 500
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $passiveRoot ".passive.lock") -Force -ErrorAction SilentlyContinue
    Write-Host "[stop] done"
}

function Show-Status {
    $pids = Find-AllDaemonPids
    if ($pids.Count -eq 0) {
        Write-Host "[status] daemon: not running"
        if (Test-Path $pidFile) { Write-Host "[status] stale pid file: $((Get-Content $pidFile) -join '')" }
        return
    }
    foreach ($p in $pids) {
        $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "[status] daemon running PID=$p started=$($proc.StartTime) uptime=$((Get-Date) - $proc.StartTime)"
        } else {
            Write-Host "[status] PID $p not alive"
        }
    }
}

function Get-TsxPath {
    $cmd = Get-Command tsx.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Path }
    # Try npx fallback
    $npx = Get-Command npx.exe -ErrorAction SilentlyContinue
    if ($npx) { return "npx tsx" }
    throw "tsx not found — run: npm install -g tsx"
}

function Find-AllDaemonPids {
    $pids = @()
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    foreach ($p in $processes) {
        if ($p.CommandLine -match '(tsx|node)[\\/]src[\\/]index\.ts|dist[\\/]index\.js') {
            $pids += $p.ProcessId
        }
    }
    return $pids
}

function Enforce-SingleDaemon {
    $pids = Find-AllDaemonPids
    if ($pids.Count -le 1) { return $pids }
    Write-Host "[warn] found $($pids.Count) daemon instances, keeping the first"
    $keep = $pids[0]
    foreach ($extraPid in $pids[1..($pids.Count - 1)]) {
        Write-Host "  killing PID $extraPid"
        Stop-Process -Id $extraPid -Force -ErrorAction SilentlyContinue
    }
    return @($keep)
}

# --- Action routing ---
switch ($Action) {
    "status" { Show-Status; exit 0 }
    "stop"   { Stop-AllDaemons; exit 0 }
    "restart" {
        Write-Host "[restart] stopping existing daemons first"
        Stop-AllDaemons
        Start-Sleep -Seconds 1
        # fall through to start logic
    }
    "start" { /* normal start below */ }
}

# Idempotency check: PID file
$existing = (Get-Content $pidFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' }) | Select-Object -First 1
if ($existing) {
    $old = [int]$existing
    $procOld = Get-Process -Id $old -ErrorAction SilentlyContinue
    if ($procOld -and $procOld.ProcessName -eq "node") {
        Write-Host "[skip] already running as PID $old (started $($procOld.StartTime))"
        exit 0
    } else {
        Write-Host "[stale-pid] removing stale .passive.pid ($old)"
        Remove-Item $pidFile -Force
    }
}

# Idempotency check: full process scan (catches orphaned daemons not in PID file)
$orphanPids = Find-AllDaemonPids
if ($orphanPids.Count -gt 0) {
    $orphanPids = Enforce-SingleDaemon
    $keepPid = $orphanPids[0]
    Write-Host "[skip] daemon already running as PID $keepPid (process scan)"
    [System.IO.File]::WriteAllText($pidFile, "$keepPid")
    exit 0
}

if (-not (Test-Path $srcEntry)) {
    Write-Host "[error] $srcEntry not found"
    exit 2
}

# Always run compiled output (production). tsx is for ad-hoc debugging only.
$tsxPath = $null
$nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Path
if (-not $nodePath) { throw "node not found in PATH" }
$distEntry = Join-Path $passiveRoot "dist\index.js"
if (-not (Test-Path $distEntry)) {
    Write-Host "[warn] $distEntry missing — falling back to tsx"
    $tsxPath = Get-TsxPath
}

Write-Host "[start] $($nodePath) (compiled)"
Write-Host "[cwd]   $passiveRoot"
Write-Host "[entry] $distEntry"

$proc = Start-Process -FilePath $nodePath `
    -ArgumentList "`"$distEntry`"" `
    -WorkingDirectory $passiveRoot `
    -WindowStyle Hidden `
    -PassThru

$nodePid = $proc.Id
[System.IO.File]::WriteAllText($pidFile, "$nodePid")

Write-Host "[ok] daemon started as PID $nodePid"

Start-Sleep -Seconds 2

$check = Get-Process -Id $nodePid -ErrorAction SilentlyContinue
if ($check) {
    Write-Host "[verified] PID $nodePid alive at $(Get-Date -Format 'HH:mm:ss')"
    exit 0
} else {
    Write-Host "[fail] daemon exited within 2s — check logs"
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 1
}

