# opencode-feishu passive monitor — create desktop shortcuts
# Pointers only — actual scripts live in passive/scripts/ inside the project.

$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot  = Resolve-Path (Join-Path $scriptRoot "..")

$pwshPath = (Get-Command pwsh.exe -ErrorAction SilentlyContinue)?.Source
if (-not $pwshPath) { $pwshPath = "powershell.exe" }

$desktopDirs = @(
    [Environment]::GetFolderPath("Desktop"),
    "D:\格外可爱的\Desktop",
    "D:\格外可爱的\Desktop\output"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

if (-not $desktopDirs) {
    Write-Host "[error] no Desktop directory found"
    exit 2
}

$shell = New-Object -ComObject WScript.Shell

$shortcuts = @(
    @{ Name = "opencode-feishu-passive-start";    Title = "OpenCode Feishu 启动";   Script = "start.ps1" },
    @{ Name = "opencode-feishu-passive-stop";     Title = "OpenCode Feishu 停止";   Script = "stop.ps1" },
    @{ Name = "opencode-feishu-passive-status";   Title = "OpenCode Feishu 状态";   Script = "status.ps1" },
    @{ Name = "opencode-feishu-passive-restart";  Title = "OpenCode Feishu 重启";   Script = "restart.ps1" },
    @{ Name = "opencode-feishu-passive-logs";     Title = "OpenCode Feishu 日志";   Script = "logs.ps1" }
)

foreach ($dir in $desktopDirs) {
    Write-Host "[desktop] $dir"
    foreach ($s in $shortcuts) {
        $target = Join-Path $dir "$($s.Name).lnk"
        $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $scriptRoot $s.Script)`""
        $sc = $shell.CreateShortcut($target)
        $sc.TargetPath = $pwshPath
        $sc.Arguments = $arg
        $sc.WorkingDirectory = $passiveRoot
        $sc.IconLocation = "powershell.exe,0"
        $sc.Description = $s.Title
        $sc.Save()
        Write-Host "  + $($s.Title) -> $($s.Script)"
    }
}

Write-Host ""
Write-Host "[ok] shortcuts created on all Desktop directories"
Write-Host "[next] run scripts\install-startup.ps1 to register Windows Task Scheduler entry"
