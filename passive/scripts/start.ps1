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
    [string]$Action = "start",
    [ValidateSet("prod", "debug")]
    [string]$Mode = "prod",
    [int]$CompleteGraceMs = 0
)

$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot  = Resolve-Path (Join-Path $scriptRoot "..")
$srcEntry     = Join-Path $passiveRoot "src\index.ts"
$logDir       = Join-Path $passiveRoot "logs"
$pidFile      = Join-Path $passiveRoot ".passive.pid"
$lockFile     = Join-Path $passiveRoot ".passive.lock"
$outLog       = Join-Path $logDir "passive.out.log"
$errLog       = Join-Path $logDir "passive.err.log"
$defaultProdGraceMs = 300000
$defaultDebugGraceMs = 15000

if ($CompleteGraceMs -le 0) {
    $CompleteGraceMs = if ($Mode -eq "debug") { $defaultDebugGraceMs } else { $defaultProdGraceMs }
}

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# --- Helpers for stop / status ---
function Stop-AllDaemons {
    $pids = Find-AllDaemonPids
    $lockPid = Get-LockPid
    if ($lockPid -and ($pids -notcontains $lockPid)) { $pids += $lockPid }
    $pidFilePid = Get-PidFilePid
    if ($pidFilePid -and ($pids -notcontains $pidFilePid)) { $pids += $pidFilePid }
    if ($pids.Count -eq 0) {
        Write-Host "[stop] no daemon running"
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
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
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    Write-Host "[stop] done"
}

function Show-Status {
    $pids = @(Find-AllDaemonPids)
    if ($pids.Count -gt 0) {
        $pids = @($pids | Sort-Object -Unique)
        $primaryPid = $pids[0]
        [System.IO.File]::WriteAllText($pidFile, "$primaryPid")
        [System.IO.File]::WriteAllText($lockFile, "$primaryPid")
    } else {
        $lockPid = Get-LockPid
        if ($lockPid) { $pids += $lockPid }
        $pidFilePid = Get-PidFilePid
        if ($pidFilePid) { $pids += $pidFilePid }
        $pids = @($pids | Sort-Object -Unique)
    }
    if ($pids.Count -eq 0) {
        Write-Host "[status] daemon: not running"
        if (Test-Path $pidFile) { Write-Host "[status] stale pid file: $((Get-Content $pidFile) -join '')" }
        if (Test-Path $lockFile) { Write-Host "[status] stale lock file: $((Get-Content $lockFile) -join '')" }
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

# Feishu OpenAPI push via daemon's own appId/appSecret (sends to same chat as cards)
$FeishuConfigPath = [System.IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), '.config', 'opencode', 'plugins', 'feishu.json')
$FeishuAppId = ""
$FeishuAppSecret = ""
try {
    $feishuCfg = Get-Content $FeishuConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $FeishuAppId = $feishuCfg.appId
    $FeishuAppSecret = $feishuCfg.appSecret
} catch { }
$FeishuChatId = "oc_82bb66a73329cf403644debd24c86ec5"

function Send-FeishuPush([string]$Title, [string]$Body) {
    if (-not $FeishuAppId -or -not $FeishuAppSecret) {
        Write-Host "  [warn] Feishu config not available, skip push"
        return
    }
    try {
        $tokenBody = @{ app_id = $FeishuAppId; app_secret = $FeishuAppSecret } | ConvertTo-Json -Depth 3 -Compress
        $tokenResp = Invoke-RestMethod -Method Post -Uri "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" -ContentType "application/json" -Body $tokenBody -TimeoutSec 10
        $token = $tokenResp.tenant_access_token
        if (-not $token) { throw "No token" }
        $text = "$Title`n$Body"
        $msgBody = @{ receive_id = $FeishuChatId; msg_type = "text"; content = (@{ text = $text } | ConvertTo-Json -Depth 3 -Compress) } | ConvertTo-Json -Depth 5 -Compress
        $headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
        $null = Invoke-RestMethod -Method Post -Uri "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" -Headers $headers -Body $msgBody -TimeoutSec 15
    } catch {
        Write-Host "  [warn] push notification failed: $($_.Exception.Message)" -ForegroundColor Yellow
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

function Get-FirstNumericFileLine([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    return (Get-Content $Path -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1)
}

function Get-PidFilePid {
    $raw = Get-FirstNumericFileLine $pidFile
    if (-not $raw) { return $null }
    return [int]$raw
}

function Get-LockPid {
    $raw = Get-FirstNumericFileLine $lockFile
    if (-not $raw) { return $null }
    return [int]$raw
}

function Test-AliveNodePid([int]$Pid) {
    if (-not $Pid) { return $false }
    $proc = Get-Process -Id $Pid -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    return $proc.ProcessName -eq "node"
}

function Find-AllDaemonPids {
    $pids = @()
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    foreach ($p in $processes) {
        $cmd = [string]$p.CommandLine
        if ($cmd -match 'opencode-feishu\\passive' -and $cmd -match 'dist[\\/]index\.js') {
            $pids += $p.ProcessId
            continue
        }
        if ($cmd -match '(tsx|node)[\\/]src[\\/]index\.ts|dist[\\/]index\.js') {
            $pids += $p.ProcessId
        }
    }
    return @($pids | Sort-Object -Unique)
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
    "start" { }  # normal start below
}

# Idempotency check: PID file
$existingRaw = Get-Content $pidFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1
if ($existingRaw) {
    $old = [int]$existingRaw
    $procOld = Get-Process -Id $old -ErrorAction SilentlyContinue
    if ($procOld -and $procOld.ProcessName -eq "node") {
        Write-Host "[skip] already running as PID $old (started $($procOld.StartTime))"
        Send-FeishuPush "OpenCode Feishu Passive 启动" "状态：已存在 (PID $old)，跳过启动"
        exit 0
    } else {
        Write-Host "[stale-pid] removing stale .passive.pid ($old)"
        Remove-Item $pidFile -Force
        Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    }
}

# Idempotency check: lock file is authoritative if it still points to a live node daemon.
$lockPid = Get-LockPid
if ($lockPid) {
    if (Test-AliveNodePid $lockPid) {
        Write-Host "[skip] daemon already running as PID $lockPid (lock file)"
        [System.IO.File]::WriteAllText($pidFile, "$lockPid")
        Send-FeishuPush "OpenCode Feishu Passive 启动" "状态：已存在 (PID $lockPid)，跳过启动"
        exit 0
    } else {
        Write-Host "[stale-lock] removing stale .passive.lock ($lockPid)"
        Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    }
}

# Idempotency check: full process scan (catches orphaned daemons not in PID file)
$orphanPids = @()
$scanProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match '(tsx|node)[\\/]src[\\/]index\.[jt]s|dist[\\/]index\.js'
}
if ($scanProcs) {
    $orphanPids = @($scanProcs | Select-Object -ExpandProperty ProcessId)
}
if ($orphanPids.Count -gt 0) {
    $orphanPids = Enforce-SingleDaemon
    $keepPid = $orphanPids[0]
    Write-Host "[skip] daemon already running as PID $keepPid (process scan)"
    [System.IO.File]::WriteAllText($pidFile, "$keepPid")
    Send-FeishuPush "OpenCode Feishu Passive 启动" "状态：已存在 (PID $keepPid)，跳过启动"
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
Write-Host "[mode]  $Mode"
Write-Host "[grace] $CompleteGraceMs ms"

$proc = Start-Process -FilePath $nodePath `
    -ArgumentList @("`"$distEntry`"", "--complete-grace-ms", "$CompleteGraceMs") `
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
    $actionLabel = if ($Action -eq "restart") { "重启" } else { "启动" }
    Send-FeishuPush "OpenCode Feishu Passive 启动" "状态：已${actionLabel} (PID $nodePid)`n模式：$Mode`n完成冷却：$CompleteGraceMs ms"
    exit 0
} else {
    Write-Host "[fail] daemon exited within 2s — check logs"
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Send-FeishuPush "OpenCode Feishu Passive 启动" "状态：启动失败 (PID $nodePid exited)"
    exit 1
}

