$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot = Resolve-Path (Join-Path $scriptRoot "..")
$pidFile = Join-Path $passiveRoot ".passive.pid"
$logDir = Join-Path $passiveRoot "logs"
$stateFile = Join-Path $logDir "notify-state.json"
$outLog = Join-Path $logDir "passive.out.log"
$errLog = Join-Path $logDir "passive.err.log"

Write-Host "=== opencode-feishu passive status ==="
Write-Host "pidfile: $pidFile"
Write-Host ""

$procId = (Get-Content $pidFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' }) | Select-Object -First 1
if (-not $procId) {
    Write-Host "state: NOT RUNNING (no .passive.pid)"
} else {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "state: STALE PID ($procId not alive)"
    } elseif ($proc.ProcessName -ne "node") {
        Write-Host "state: MISMATCH (PID $procId is $($proc.ProcessName), not node)"
    } else {
        $cpu = "{0:N1}" -f $proc.CPU
        $ws  = "{0:N1} MB" -f ($proc.WorkingSet64 / 1MB)
        $uptime = (Get-Date) - $proc.StartTime
        Write-Host "state: RUNNING"
        Write-Host "  pid     : $procId"
        Write-Host "  started : $($proc.StartTime)"
        Write-Host "  uptime  : $($uptime.Days)d $($uptime.Hours)h $($uptime.Minutes)m"
        Write-Host "  cpu     : $cpu s"
        Write-Host "  mem     : $ws"
    }
}

Write-Host ""
Write-Host "notify-state.json:"
if (Test-Path $stateFile) {
    $fi = Get-Item $stateFile
    Write-Host "  path    : $stateFile"
    Write-Host "  size    : $($fi.Length) B"
    Write-Host "  mtime   : $($fi.LastWriteTime)"
    try {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json
        $schemaVersion = $state._schemaVersion
        $sessions = @()
        foreach ($prop in $state.PSObject.Properties) {
            if (-not $prop.Name.StartsWith("_")) {
                $sessions += $prop
            }
        }
        $count = $sessions.Count
        Write-Host "  schema  : $schemaVersion"
        Write-Host "  sessions: $count"
        if ($count -gt 0) {
            $now = Get-Date
            $recentCutoff = $now.AddMinutes(-5)
            $recent = @($sessions | Where-Object { $_.Value.lastPushedAt -and (Get-Date 1970-01-01).AddMilliseconds($_.Value.lastPushedAt) -gt $recentCutoff })
            Write-Host "  active  : $($recent.Count) pushed in last 5 min"
            $top5 = $sessions | Sort-Object { $_.Value.lastPushedAt } -Descending | Select-Object -First 5
            foreach ($s in $top5) {
                $t = (Get-Date 1970-01-01).AddMilliseconds($s.Value.lastPushedAt)
                $age = (New-TimeSpan -Start $t -End (Get-Date)).ToString("hh\:mm\:ss") + " ago"
                Write-Host "    $($s.Name): lastSeen=$($s.Value.lastSeenTime) pushed=$age"
            }
        }
    } catch {
        Write-Host "  (failed to parse: $_)"
    }
} else {
    Write-Host "  (not found — daemon never started or first run)"
}

Write-Host ""
Write-Host "last log lines (passive.out.log):"
if (Test-Path $outLog) {
    Get-Content $outLog -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "  (no log yet)"
}

if ((Test-Path $errLog) -and (Get-Item $errLog).Length -gt 0) {
    $errInfo = Get-Item $errLog
    $showErr = $true
    if ($proc -and $errInfo.LastWriteTime -lt $proc.StartTime) {
        $showErr = $false
        Write-Host ""
        Write-Host "INFO: passive.err.log only has historical content (older than current daemon start)"
        Write-Host "  path  : $errLog"
        Write-Host "  mtime : $($errInfo.LastWriteTime)"
    }
    if ($showErr) {
        Write-Host ""
        Write-Host "WARN: passive.err.log has content:"
        Get-Content $errLog -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
    }
}

Write-Host ""
Write-Host "Task Scheduler:"
$task = Get-ScheduledTask -TaskName "OpenCodeFeishuPassive" -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "  registered: yes (state=$($task.State))"
} else {
    Write-Host "  registered: no (run scripts\install-startup.ps1 to enable boot autostart)"
}
