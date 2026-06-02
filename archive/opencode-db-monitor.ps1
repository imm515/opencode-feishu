param(
    [string]$DbPath = "$env:USERPROFILE\.local\share\opencode\opencode.db",
    [string]$ChatId = "oc_82bb66a73329cf403644debd24c86ec5",
    [int]$PollMs = 20000,
    [switch]$Daemon,
    [switch]$Debug,
    [string]$SessionTitle = "",
    [string]$Duration = "",
    [string]$NotifyType = "info"
)

$ErrorActionPreference = "Stop"

function Send-FeishuCard($title, $bodyMd, $color) {
    if ([string]::IsNullOrWhiteSpace($color)) { $color = "blue" }
    $cfg = Get-Content "$env:USERPROFILE\.config\opencode\plugins\feishu.json" -Raw | ConvertFrom-Json
    $body = @{app_id=$cfg.appId; app_secret=$cfg.appSecret} | ConvertTo-Json -Compress
    $tokenResp = Invoke-RestMethod -Uri "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" -Method Post -Body $body -ContentType "application/json" -Proxy "http://127.0.0.1:10809"
    $token = $tokenResp.tenant_access_token
    $card = @{
        config = @{wide_screen_mode=$true}
        header = @{title=@{tag="plain_text"; content=$title}; template=$color}
        elements = @(
            @{tag="markdown"; content=$bodyMd}
        )
    }
    $contentStr = $card | ConvertTo-Json -Compress -Depth 10
    $msgBody = @{receive_id=$ChatId; msg_type="interactive"; content=$contentStr} | ConvertTo-Json -Compress -Depth 5
    try {
        $resp = Invoke-RestMethod -Uri "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" -Method Post -Headers @{Authorization="Bearer $token"} -Body $msgBody -ContentType "application/json" -Proxy "http://127.0.0.1:10809"
        if ($Debug) {
            if ($resp.code -eq 0) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Card sent: $($resp.data.message_id)" }
            else { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Card error: $($resp.code) $($resp.msg)" }
        }
    } catch { if ($Debug) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Card exception: $_" } }
}

function Get-SessionInfo($sid) {
    $q = "SELECT title, time_created, time_updated FROM session WHERE id='$sid'"
    $row = & sqlite3 $DbPath $q 2>&1
    if ([string]::IsNullOrWhiteSpace($row)) { return @{} }
    $parts = $row -split '\|'
    $title = $parts[0]
    $created = if ($parts.Length -ge 2) { [long]$parts[1] } else { 0 }
    $updated = if ($parts.Length -ge 3) { [long]$parts[2] } else { 0 }
    $durMin = if ($created -gt 0) { [math]::Round(($updated - $created) / 60000, 1) } else { 0 }
    $createdStr = if ($created -gt 0) { (Get-Date -Date "1970-01-01 00:00:00Z").AddMilliseconds($created).ToLocalTime().ToString("MM-dd HH:mm") } else { "?" }
    return @{title=$title; duration="${durMin}分钟"; created=$createdStr}
}

$sessions = @{}
$firstRun = $true
if ($Debug) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Monitor started. Poll=${PollMs}ms ChatId=${ChatId}" }

function Get-SessionState($sid) {
    $q = "SELECT json_extract(p.data, '$.type'), json_extract(p.data, '$.state.status') FROM part p WHERE p.session_id = '$sid' ORDER BY p.time_created DESC LIMIT 1"
    $lastPart = & sqlite3 $DbPath $q 2>&1
    if ([string]::IsNullOrWhiteSpace($lastPart)) { return "no_parts" }
    $fields = $lastPart -split '\|'
    $partType = ($fields[0] -replace '\s','')
    $toolStat = if ($fields.Length -ge 2) { ($fields[1] -replace '\s','') } else { "" }
    $q2 = "SELECT COUNT(*) FROM part p WHERE p.session_id = '$sid' AND json_extract(p.data, '$.type') = 'tool' AND json_extract(p.data, '$.state.status') = 'running'"
    $runCount = & sqlite3 $DbPath $q2 2>&1
    if ($runCount.Trim() -ne "0") { return "working" }
    if ($partType -eq "text") { return "waiting" }
    if ($partType -eq "reasoning") { return "reasoning" }
    if ($partType -eq "tool" -and $toolStat -eq "completed") { return "waiting" }
    return "unknown"
}

while ($true) {
    try { $rows = & sqlite3 $DbPath "SELECT id, title, time_updated, time_archived FROM session ORDER BY time_updated DESC LIMIT 20" 2>&1 }
    catch { Start-Sleep -Milliseconds $PollMs; continue }

    $seenIds = @{}
    foreach ($row in $rows) {
        $parts = $row -split '\|'
        if ($parts.Length -lt 4) { continue }
        $sid = $parts[0].Trim(); $title = $parts[1]
        $tu = [long]$parts[2]
        $ta = if ($parts[3] -eq "") { $null } else { [long]$parts[3] }
        $seenIds[$sid] = $true
        $aiState = Get-SessionState $sid
        $safeTitle = $title -replace '\|', ''

        if (-not $sessions.ContainsKey($sid)) {
            $sessions[$sid] = @{ time_updated=$tu; title=$title; ai_state=$aiState }
            if ($Debug) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Track: $($sid.Substring(0,25))... state=$aiState" }
            continue
        }

        $state = $sessions[$sid]; $oldState = $state.ai_state

        if ($ta -ne $null -and $state.ai_state -ne "done") {
            $state.ai_state = "done"
            $info = Get-SessionInfo $sid
            $safeTitle = $info.title -replace '\|', ''
            $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            $bodyMd = "📄 **${safeTitle}**\n\n🕐 开始: ${info.created}\n⏱ 耗时: ${info.duration}\n\n✅ @所有人"
            if ($Debug) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] DONE: $safeTitle (${info.duration})" }
            Send-FeishuCard "✅ 任务完成" $bodyMd "green"
            continue
        }
        if ($tu -eq $state.time_updated -and $aiState -eq $oldState) { continue }
        $state.time_updated = $tu; $state.ai_state = $aiState
        if ($firstRun) { continue }

        if ($oldState -eq "waiting" -and $aiState -eq "working") {
            $info = Get-SessionInfo $sid
            $safeTitle = $info.title -replace '\|', ''
            $now = Get-Date -Format "HH:mm:ss"
            $bodyMd = "📄 **${safeTitle}**\n\n💬 已收到新回复，任务继续执行\n\n⏱ ${now}\n@所有人"
            if ($Debug) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] RESUME: $safeTitle" }
            Send-FeishuCard "🔄 继续执行" $bodyMd "blue"
        }
    }

    foreach ($sid in $sessions.Keys) {
        if (-not $seenIds.ContainsKey($sid) -and $sessions[$sid].ai_state -ne "gone") {
            $sessions[$sid].ai_state = "gone"
            $info = Get-SessionInfo $sid
            $safeTitle = $info.title -replace '\|', ''
            $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            $bodyMd = "📄 **${safeTitle}**\n\n🕐 ${info.created}\n⏱ ${info.duration}\n\n⏱ ${now}\n@所有人"
            if ($Debug) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] GONE: $safeTitle" }
            Send-FeishuCard "🗑 会话已关闭" $bodyMd "grey"
        }
    }

    $firstRun = $false
    if (-not $Daemon) { break }
    Start-Sleep -Milliseconds $PollMs
}
