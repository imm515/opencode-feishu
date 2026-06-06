$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot  = Resolve-Path (Join-Path $scriptRoot "..")
$archiveDir   = 'D:\Program Files Dev\快捷方式归档\OpenCode'

$desktopDirs = @(
    [Environment]::GetFolderPath("Desktop"),
    "D:\格外可爱的\Desktop"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

if (-not (Test-Path $archiveDir)) {
    New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
$pwshPath = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwshPath) {
    $pwshPath = 'powershell.exe'
}
$targetPath = 'C:\Windows\System32\cmd.exe'
$arguments = '/c chcp 65001 >nul && "' + $pwshPath + '" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "D:\Program Files Dev\opencode-feishu\passive\scripts\opencode_feishu_passive_ctl.ps1" auto'
$legacyNames = @(
    'opencode-feishu-passive-start.lnk',
    'opencode-feishu-passive-stop.lnk',
    'opencode-feishu-passive-status.lnk',
    'opencode-feishu-passive-restart.lnk',
    'opencode-feishu-passive-logs.lnk'
)

$shortcutTargets = @($archiveDir) + $desktopDirs
foreach ($dir in $shortcutTargets) {
    foreach ($legacy in $legacyNames) {
        $legacyPath = Join-Path $dir $legacy
        if (Test-Path $legacyPath) {
            Remove-Item -LiteralPath $legacyPath -Force -ErrorAction SilentlyContinue
            Write-Host "[cleanup] removed $legacyPath"
        }
    }
    $shortcutPath = Join-Path $dir 'OpenCodeFeishuPassive.lnk'
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $targetPath
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $passiveRoot
    $shortcut.IconLocation = 'C:\Windows\System32\cmd.exe,0'
    $shortcut.Description = 'OpenCode Feishu Passive Control'
    $shortcut.Save()
    Write-Host "[ok] wrote $shortcutPath"
}
