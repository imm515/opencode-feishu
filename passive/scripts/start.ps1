# opencode-feishu passive monitor — start daemon
# Direct node.exe spawn (no cmd.exe wrapper), captures the actual node PID.
# Idempotent: if already running, prints existing PID and exits 0.

$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot  = Resolve-Path (Join-Path $scriptRoot "..")
$distEntry    = Join-Path $passiveRoot "dist\index.js"
$logDir       = Join-Path $passiveRoot "logs"
$pidFile      = Join-Path $passiveRoot ".passive.pid"
$outLog       = Join-Path $logDir "passive.out.log"
$errLog       = Join-Path $logDir "passive.err.log"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Get-NodePath {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Path }
    $candidates = @(
        "C:\Program Files\nodejs\node.exe",
        "D:\Program Files\nodejs\node.exe"
    )
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
    throw "node.exe not found in PATH or $candidates"
}

function Find-AllDaemonPids {
    $pids = @()
    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $processes) {
        if ($p.CommandLine -match 'dist[\\/]index\.js') {
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

if (-not (Test-Path $distEntry)) {
    Write-Host "[error] dist\index.js not found at $distEntry — run 'npm run build' first"
    exit 2
}

$nodePath = Get-NodePath

Write-Host "[start] $nodePath"
Write-Host "[cwd]   $passiveRoot"
Write-Host "[entry] $distEntry"
Write-Host "[out]   $outLog"
Write-Host "[err]   $errLog"

$proc = Start-Process -FilePath $nodePath `
    -ArgumentList "`"$distEntry`"" `
    -WorkingDirectory $passiveRoot `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError  $errLog `
    -WindowStyle Hidden `
    -PassThru

$nodePid = $proc.Id
[System.IO.File]::WriteAllText($pidFile, "$nodePid")

Write-Host "[ok] node started as PID $nodePid"

Start-Sleep -Seconds 2

$check = Get-Process -Id $nodePid -ErrorAction SilentlyContinue
if ($check) {
    Write-Host "[verified] PID $nodePid alive at $(Get-Date -Format 'HH:mm:ss')"
    exit 0
} else {
    Write-Host "[fail] node exited within 2s — see $errLog"
    if (Test-Path $errLog) {
        Get-Content $errLog | Select-Object -Last 20 | ForEach-Object { Write-Host "  $_" }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 1
}

