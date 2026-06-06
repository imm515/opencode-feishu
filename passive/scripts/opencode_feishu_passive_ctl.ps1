$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

param(
  [Parameter(Position = 0)]
  [ValidateSet('start','stop','restart','status','menu','auto')]
  [string]$Action = 'auto'
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PassiveRoot = Resolve-Path (Join-Path $ScriptDir '..')
$StartScript = Join-Path $ScriptDir 'start.ps1'
$StopScript = Join-Path $ScriptDir 'stop.ps1'
$StatusScript = Join-Path $ScriptDir 'status.ps1'
$AutoStartScript = Join-Path $ScriptDir 'opencode_feishu_passive_autostart.ps1'
$PidFile = Join-Path $PassiveRoot '.passive.pid'

function Write-Status {
  param([string]$Message, [string]$Color = 'White')
  Write-Host "[passive] $Message" -ForegroundColor $Color
}

function Invoke-Countdown {
  param(
    [int]$Seconds,
    [string]$Activity
  )

  for ($remaining = $Seconds; $remaining -ge 1; $remaining--) {
    $done = $Seconds - $remaining
    $percent = [int](($done / [math]::Max($Seconds, 1)) * 100)
    Write-Progress -Activity $Activity -Status "Starting in $remaining seconds" -PercentComplete $percent
    Start-Sleep -Seconds 1
  }
  Write-Progress -Activity $Activity -Completed
}

function Pause-ForUser {
  Write-Host ''
  Write-Host 'Press Enter to continue...' -ForegroundColor DarkGray
  $null = Read-Host
}

function Get-PassiveProcess {
  if (Test-Path $PidFile) {
    $raw = Get-Content $PidFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1
    if ($raw) {
      $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq 'node') {
        return $proc
      }
    }
  }

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match 'opencode-feishu\\passive' -and $_.CommandLine -match 'dist[\\/]index\.js'
  } | ForEach-Object {
    Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  } | Select-Object -First 1
}

function Show-Menu {
  do {
    $running = Get-PassiveProcess
    Clear-Host
    Write-Host '=================================' -ForegroundColor Cyan
    Write-Host '   OpenCode Feishu Passive Control' -ForegroundColor Cyan
    if ($running) {
      Write-Host "   STATUS: Running (PID $($running.Id))" -ForegroundColor Green
    } else {
      Write-Host '   STATUS: Stopped' -ForegroundColor Red
    }
    Write-Host '=================================' -ForegroundColor Cyan
    if ($running) { Write-Host '  [2] Stop' } else { Write-Host '  [1] Start' }
    Write-Host '  [3] Restart'
    Write-Host '  [4] Status'
    Write-Host '  [5] Exit'
    Write-Host ''
    $choice = Read-Host 'Select [1-5]'
    switch ($choice) {
      '1' {
        if (-not $running) {
          & $StartScript
        } else {
          Write-Status 'Already running.' 'Yellow'
          Start-Sleep -Seconds 1
        }
      }
      '2' {
        if ($running) {
          & $StopScript
        } else {
          Write-Status 'Not running.' 'Yellow'
          Start-Sleep -Seconds 1
        }
      }
      '3' {
        & $StartScript -Action restart
      }
      '4' {
        & $StatusScript
        Pause-ForUser
      }
      '5' { return }
    }
  } while ($true)
}

switch ($Action) {
  'start' {
    & $StartScript
  }
  'stop' {
    & $StopScript
  }
  'restart' {
    & $StartScript -Action restart
  }
  'status' {
    & $StatusScript
  }
  'menu' {
    Show-Menu
  }
  'auto' {
    if (Get-PassiveProcess) {
      Show-Menu
      break
    }

    Write-Status 'OpenCode Feishu Passive AutoStart' 'Cyan'
    Write-Status 'Manual control menu will appear when passive is already running.' 'DarkGray'
    Invoke-Countdown -Seconds 10 -Activity 'Starting OpenCode Feishu Passive'
    & $AutoStartScript -AutoStart
    $exitCode = $LASTEXITCODE
    if (Get-PassiveProcess) {
      Write-Status 'Passive started successfully. Open this shortcut again for the control menu.' 'Green'
    } else {
      Write-Status 'Passive failed to start. Check passive logs.' 'Red'
    }
    Start-Sleep -Seconds 3
    exit $exitCode
  }
}
