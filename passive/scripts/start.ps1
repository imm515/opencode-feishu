# opencode-feishu passive monitor — start daemon
# Uses tsx to run TypeScript directly (no build step needed).
# Idempotent: if already running, prints existing PID and exits 0.

$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot  = Resolve-Path (Join-Path $scriptRoot "..")
$srcEntry     = Join-Path $passiveRoot "src\index.ts"
$logDir       = Join-Path $passiveRoot "logs"
$pidFile      = Join-Path $passiveRoot ".passive.pid"
$outLog       = Join-Path $logDir "passive.out.log"
$errLog       = Join-Path $logDir "passive.err.log"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

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

$tsxPath = Get-TsxPath

Write-Host "[start] $tsxPath"
Write-Host "[cwd]   $passiveRoot"
Write-Host "[entry] $srcEntry"

$proc = Start-Process -FilePath ($tsxPath.Split(" ")[0]) `
    -ArgumentList "$($tsxPath.Split(" ")[1..99] -join ' ') `"$srcEntry`"" `
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

