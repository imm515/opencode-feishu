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

- `Startup\OpenCodeFeishuPassive.lnk` should point to the visible `.bat` wrapper, not a hidden launcher
- expected user-facing flow:
  - 10 second countdown
  - start or skip
  - 3 second tail exit
