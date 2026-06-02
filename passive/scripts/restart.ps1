# opencode-feishu passive monitor — restart
& (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "stop.ps1")
Start-Sleep -Seconds 1
& (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "start.ps1")
exit $LASTEXITCODE

