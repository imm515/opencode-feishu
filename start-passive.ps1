$ErrorActionPreference = "SilentlyContinue"
$scriptRoot = "D:\Program Files Dev\opencode-feishu\passive"
$logDir = "$scriptRoot\logs"
$logFile = Join-Path $logDir "passive.log"
$pidFile = Join-Path $scriptRoot ".passive.pid"
$batFile = Join-Path $scriptRoot "run.bat"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$existing = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($existing) {
    $old = [int]$existing
    $procOld = Get-Process -Id $old -ErrorAction SilentlyContinue
    if ($procOld) {
        Write-Host "Already running as PID $old"
        exit 0
    }
}

Write-Host "Starting opencode-feishu passive monitor..."
Write-Host "Log: $logFile"

$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = "cmd.exe"
$pinfo.Arguments = "/c `"$batFile`""
$pinfo.WorkingDirectory = $scriptRoot
$pinfo.UseShellExecute = $false
$pinfo.CreateNoWindow = $true
$pinfo.RedirectStandardOutput = $true
$pinfo.RedirectStandardError = $true

$proc = [System.Diagnostics.Process]::Start($pinfo)
$myPid = $proc.Id
[System.IO.File]::WriteAllText($pidFile, "$myPid")

Write-Host "Started PID=$myPid"

Start-Sleep -Seconds 5

$logContent = Get-Content $logFile -ErrorAction SilentlyContinue
if ($logContent) {
    $logContent | Select-Object -Last 5 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host "No log output yet"
}

$check = Get-Process -Id $myPid -ErrorAction SilentlyContinue
if ($check) {
    Write-Host "Running in background"
} else {
    Write-Host "Process exited with code $($proc.ExitCode)"
    $errOut = $proc.StandardError.ReadToEnd()
    if ($errOut) { Write-Host "STDERR: $errOut" }
}

exit 0