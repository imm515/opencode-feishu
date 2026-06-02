# opencode-feishu passive monitor — tail logs
param(
    [int]$Lines = 40,
    [switch]$Follow
)

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$passiveRoot  = Resolve-Path (Join-Path $scriptRoot "..")
$outLog       = Join-Path $passiveRoot "logs\passive.out.log"
$errLog       = Join-Path $passiveRoot "logs\passive.err.log"
$dateLogDir   = Join-Path $passiveRoot "logs"

function Show-Log($path) {
    if (Test-Path $path) {
        Write-Host "=== $path ==="
        Get-Content $path -Tail $Lines -ErrorAction SilentlyContinue
    } else {
        Write-Host "=== $path (missing) ==="
    }
}

Show-Log $outLog
Write-Host ""
Show-Log $errLog

$today = Get-Date -Format "yyyy-MM-dd"
$dateLog = Join-Path $dateLogDir "$today.log"
if (Test-Path $dateLog) {
    Write-Host ""
    Show-Log $dateLog
}

if ($Follow) {
    Write-Host ""
    Write-Host "--- following $outLog (Ctrl-C to stop) ---"
    Get-Content $outLog -Tail $Lines -Wait -ErrorAction SilentlyContinue
}
