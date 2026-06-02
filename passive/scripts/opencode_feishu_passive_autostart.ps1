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

# Feishu webhook for push notification
$WebhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/0bfd8b32-ca7f-4075-a24b-cd42cf9f3b13'

function Write-Step([string]$Message, [string]$Color = 'Cyan') {
  Write-Host "  $Message" -ForegroundColor $Color
}

function Write-Result([string]$Message, [string]$Color = 'Green') {
  Write-Host "  $Message" -ForegroundColor $Color
}

function Send-FeishuPush([string]$Title, [string]$Body) {
  $text = "$Title`n$Body"
  try {
    $payload = @{
      msg_type = 'text'
      content  = @{ text = $text }
    } | ConvertTo-Json -Depth 5 -Compress
    Invoke-RestMethod -Method Post -Uri $WebhookUrl -ContentType 'application/json; charset=utf-8' -Body $payload -TimeoutSec 15 | Out-Null
  } catch {
    Write-Step "  [warn] push notification failed: $($_.Exception.Message)" 'Yellow'
  }
}

function Test-DaemonRunning {
  # Check PID file
  $existing = Get-Content $PidFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1
  if ($existing) {
    $pid = [int]$existing
    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') {
      return $pid
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
