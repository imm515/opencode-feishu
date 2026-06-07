# opencode-feishu Repository Notes

## Autostart Routing

- `passive/scripts/opencode_feishu_passive_autostart.ps1` must not use the old Ivy Assistant webhook
- do not hardcode `https://open.feishu.cn/open-apis/bot/v2/hook/0bfd8b32-ca7f-4075-a24b-cd42cf9f3b13` for passive autostart notifications
- that webhook routes to the Ivy Assistant bot and caused passive startup notices to appear in the wrong chat
- passive autostart notifications must instead use Feishu OpenAPI with the daemon app credentials from:
  - `%USERPROFILE%\.config\opencode\plugins\feishu.json`
- current validated target chat for passive startup notices:
  - `oc_82bb66a73329cf403644debd24c86ec5`
- validated on 2026-06-07 via `lark-cli`:
  - message `OpenCode Feishu Passive 自启动`
  - body `状态：已存在 (PID 13440)，跳过启动`
  - sender app `cli_aa943aedd723dbc0`

## Autostart UX

- preferred autostart mechanism is now:
  - Startup shortcut only
- legacy Scheduled Task is no longer authoritative and was manually removed on 2026-06-07
- authoritative Startup shortcut:
  - `C:\Users\Faye Wang\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\OpenCodeFeishuPassive.lnk`
- authoritative desktop/archive launchers:
  - `D:\格外可爱的\Desktop\OpenCodeFeishuPassive.lnk`
  - `D:\Program Files Dev\快捷方式归档\OpenCode\OpenCodeFeishuPassive.lnk`
- all should point to:
  - `cmd.exe /c chcp 65001 >nul && "C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "D:\Program Files Dev\opencode-feishu\passive\scripts\opencode_feishu_passive_ctl.ps1" auto`

### UX contract

- cold start:
  - visible launcher window
  - wait about 10 seconds
  - start through the passive control/autostart chain
  - auto-close about 3 seconds later
- second launch while already running:
  - enter interactive control menu
  - do not flash-exit

### Safety rules

- keep duplicate-start protection
- do not pre-write `.passive.lock` from `passive/scripts/start.ps1`
- trust the daemon's own lock lifecycle
- if a future startup failure mentions `Access is denied` around Scheduled Task cleanup, treat that as a permission/UAC question first, not a daemon-state fact
