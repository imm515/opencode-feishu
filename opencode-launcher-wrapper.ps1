param(
    [string]$TaskDesc = "opencode",
    [string[]]$OpenCodeArgs = @(),
    [string]$ChatId = "oc_7a7a790620d8b03f026825565df6e151",
    [string]$Identity = "user",
    [int]$IdleWarnSec = 90,
    [switch]$NoProxy
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NotifyScript = Join-Path $ScriptDir "feishu-notify.ps1"

$OpenCodeExe = "D:\npm\global\node_modules\opencode-ai\bin\opencode.exe"

# Mark start
$startStr = "**🚀 任务启动: ${TaskDesc}**"
& $NotifyScript -Message $startStr -ChatId $ChatId -Identity $Identity -NoProxy:$NoProxy

# Launch opencode in a new window (keeps TUI interactive)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $OpenCodeExe
$psi.Arguments = $OpenCodeArgs -join " "
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.WorkingDirectory = "D:\Program Files Dev"

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$proc.Start() | Out-Null

$lastOutput = Get-Date
$lastLine = ""

# Read stdout until process exits
$reader = $proc.StandardOutput
$errorReader = $proc.StandardError

while (!$proc.HasExited) {
    $line = $reader.ReadLine()
    if ($line -ne $null) {
        $lastOutput = Get-Date
        $lastLine = $line
    }

    # Check idle timeout
    $idleSec = [math]::Round(((Get-Date) - $lastOutput).TotalSeconds)
    if ($idleSec -ge $IdleWarnSec -and $idleSec % 30 -eq 0) {
        $partial = if ($lastLine.Length -gt 80) { $lastLine.Substring(0,80) + "..." } else { $lastLine }
        $safePartial = $partial -replace '\x1b\[[0-9;]*m', ''
        $msg = "**❓ 需要关注: ${TaskDesc}**%0a%0a📄 最后输出: ${safePartial}%0a⏱ 已等待 ${idleSec}s"
        & $NotifyScript -Message $msg -ChatId $ChatId -Identity $Identity -NoProxy:$NoProxy
        $lastOutput = Get-Date  # reset to avoid spam
    }

    Start-Sleep -Milliseconds 500
}

$exitCode = $proc.ExitCode
$now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

if ($exitCode -eq 0) {
    $icon = "✅"
    $status = "已完成"
} else {
    $icon = "❌"
    $status = "异常退出 (code: ${exitCode})"
}

$completionMsg = "**${icon} ${TaskDesc} ${status}**%0a%0a📅 ${now}"
& $NotifyScript -Message $completionMsg -ChatId $ChatId -Identity $Identity -NoProxy:$NoProxy

exit $exitCode
