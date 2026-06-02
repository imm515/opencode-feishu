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

# Idempotency check
$existing = Get-Content $pidFile -ErrorAction SilentlyContinue
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

