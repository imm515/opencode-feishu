param(
    [string]$Message = "",
    [string]$ChatId = "oc_82bb66a73329cf403644debd24c86ec5",
    [switch]$Debug
)

$ErrorActionPreference = "Stop"

$cfg = Get-Content "$env:USERPROFILE\.config\opencode\plugins\feishu.json" -Raw | ConvertFrom-Json
$now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$body = @{app_id=$cfg.appId; app_secret=$cfg.appSecret} | ConvertTo-Json -Compress
$tokenResp = Invoke-RestMethod -Uri "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" -Method Post -Body $body -ContentType "application/json" -Proxy "http://127.0.0.1:10809"
$token = $tokenResp.tenant_access_token
if ($Debug) { Write-Host "Token obtained" }

$postObj = @{
    zh_cn = @{
        title = ""
        content = @(
            @(@{tag="md"; text="${Message}\n\n📅 ${now}"}),
            @(@{tag="at"; user_id="all"; user_name="所有人"})
        )
    }
}
$contentStr = $postObj | ConvertTo-Json -Compress -Depth 10
$msgBody = @{receive_id=$ChatId; msg_type="post"; content=$contentStr} | ConvertTo-Json -Compress -Depth 5

try {
    $resp = Invoke-RestMethod -Uri "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" -Method Post -Headers @{Authorization="Bearer $token"} -Body $msgBody -ContentType "application/json" -Proxy "http://127.0.0.1:10809"
    if ($Debug) {
        if ($resp.code -eq 0) { Write-Host "OK msgId=$($resp.data.message_id)" }
        else { Write-Host "Error: $($resp.code) $($resp.msg)" }
    }
} catch {
    if ($Debug) { Write-Host "ERROR: $_" }
}
