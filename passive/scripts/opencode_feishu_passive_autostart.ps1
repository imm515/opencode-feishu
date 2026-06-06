# opencode-feishu passive autostart control
# Style: follows feishu_bot_ctl.ps1 convention
# Idempotent: checks existing PID, skips if already running

param(
  [switch]$AutoStart
)

$ErrorActionPreference = 'Stop'
if ($Host.UI -and $Host.UI.RawUI) {
  $Host.UI.RawUI.WindowTitle = 'OpenCode Feishu Passive AutoStart'
}

$PassiveRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$ScriptsDir   = Join-Path $PassiveRoot 'scripts'
$StartScript  = Join-Path $ScriptsDir 'start.ps1'
$PidFile      = Join-Path $PassiveRoot '.passive.pid'
$LogDir       = Join-Path $PassiveRoot 'logs'
$OutLog       = Join-Path $LogDir 'autostart.out.log'
$ErrLog       = Join-Path $LogDir 'autostart.err.log'

# Feishu OpenAPI push via daemon's own appId/appSecret
$FeishuConfigPath = [System.IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), '.config', 'opencode', 'plugins', 'feishu.json')
$FeishuAppId = ""
$FeishuAppSecret = ""
try {
  $feishuCfg = Get-Content $FeishuConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
  $FeishuAppId = $feishuCfg.appId
  $FeishuAppSecret = $feishuCfg.appSecret
} catch {}
$FeishuChatId = "oc_82bb66a73329cf403644debd24c86ec5"

function Write-Step([string]$Message, [string]$Color = 'Cyan') {
  Write-Host "  $Message" -ForegroundColor $Color
}

function Write-Result([string]$Message, [string]$Color = 'Green') {
  Write-Host "  $Message" -ForegroundColor $Color
}

function Send-FeishuPush([string]$Title, [string]$Body) {
  if (-not $FeishuAppId -or -not $FeishuAppSecret) {
    Write-Step "[warn] Feishu config not available, skip push" 'Yellow'
    return
  }
  try {
    $tokenBody = @{ app_id = $FeishuAppId; app_secret = $FeishuAppSecret } | ConvertTo-Json -Depth 3 -Compress
    $tokenResp = Invoke-RestMethod -Method Post -Uri "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" -ContentType "application/json" -Body $tokenBody -TimeoutSec 10
    $token = $tokenResp.tenant_access_token
    if (-not $token) { throw "No token" }
    $text = "$Title`n$Body"
    $msgBody = @{ receive_id = $FeishuChatId; msg_type = "text"; content = (@{ text = $text } | ConvertTo-Json -Depth 3 -Compress) } | ConvertTo-Json -Depth 5 -Compress
    $headers = @{ Authorization = "Bearer $token" }
    $utf8Body = [System.Text.Encoding]::UTF8.GetBytes($msgBody)
    Invoke-RestMethod -Method Post -Uri "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $utf8Body -TimeoutSec 15 | Out-Null
  } catch {
    Write-Step "[warn] push notification failed: $($_.Exception.Message)" 'Yellow'
  }
}

function Test-DaemonRunning {
  # Check PID file
  $existing = Get-Content $PidFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1
  if ($existing) {
    $existingPid = [int]$existing
    $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') {
      return $existingPid
    }
  }

  # Full process scan fallback
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -match '(tsx|node).*src[\\/]index\.[jt]s' -or $_.CommandLine -match 'node.*dist[\\/]index\.js'
  }
  if ($procs) {
    $firstPid = $procs | Select-Object -First 1 -ExpandProperty ProcessId
    return $firstPid
  }

  return $null
}

# --- Main ---

Write-Step ''
Write-Step 'OpenCode Feishu Passive Daemon AutoStart'
Write-Step '=========================================='
Write-Step ''

if (-not $AutoStart) {
  Write-Step 'Starting in 5 seconds...' 'DarkGray'
  Write-Step '(press Ctrl+C to cancel)' 'DarkGray'
  Start-Sleep -Seconds 5
  Write-Step ''
}

# --- Check already running ---
$runningPid = Test-DaemonRunning
if ($runningPid) {
  $startTime = (Get-Process -Id $runningPid -ErrorAction SilentlyContinue | Select-Object -ExpandProperty StartTime)
  Write-Result "[skip] daemon already running as PID $runningPid"
  if ($startTime) {
    Write-Step "       started at $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))" 'DarkGray'
  }
  Write-Step ''

  Send-FeishuPush "OpenCode Feishu Passive 自启动" "状态：已存在 (PID $runningPid)，跳过启动"
  Write-Result "[push] notification sent (skip)"
  Write-Step ''
  Write-Result '  [DONE]'
  Start-Sleep -Seconds 3
  exit 0
}

# --- Start daemon ---
Write-Step 'Starting passive daemon...'

if (-not (Test-Path $StartScript)) {
  Write-Host "  [error] start script not found: $StartScript" -ForegroundColor Red
  Write-Host ''
  Start-Sleep -Seconds 5
  exit 2
}

try {
  & $StartScript
  $exitCode = $LASTEXITCODE
} catch {
  Write-Host "  [error] $($_.Exception.Message)" -ForegroundColor Red
  $exitCode = 1
}

if ($exitCode -eq 0) {
  $newPid = Test-DaemonRunning
  Write-Result "[ok] daemon started successfully"
  if ($newPid) {
    Write-Step "       PID $newPid"
  }
  Write-Step ''
  $pidStr = if ($newPid) { "$newPid" } else { 'unknown' }
  Send-FeishuPush "OpenCode Feishu Passive 自启动" "状态：已启动 (PID $pidStr)"
  Write-Result "[push] notification sent (started)"
  Write-Step ''
  Write-Result '  [DONE]'
} else {
  Write-Host "  [fail] daemon failed to start (exit code $exitCode)" -ForegroundColor Red
  Write-Step '  check logs for details:' 'DarkGray'
  Write-Step "    $OutLog" 'DarkGray'
  Write-Step "    $ErrLog" 'DarkGray'
  Write-Step ''
  Send-FeishuPush "OpenCode Feishu Passive 自启动" "状态：启动失败 (exit code $exitCode)"
  Write-Step "[push] notification sent (failed)" 'Yellow'
  Write-Step ''
  Write-Result '  [DONE]'
}

Start-Sleep -Seconds 3
exit $exitCode
