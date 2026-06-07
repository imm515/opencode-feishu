# opencode-feishu Passive Mode

## Startup Rules Override (2026-06-07)

This section supersedes older passive autostart notes in this file when they conflict.

### Authoritative startup path

- preferred boot-start mechanism:
  - Startup shortcut only
- old `OpenCodeFeishuPassive` Scheduled Task is no longer authoritative
- after manual cleanup on 2026-06-07, the healthy expected state is:
  - `scripts/status.ps1` reports `Task Scheduler: registered: no`
- authoritative Startup shortcut:
  - `C:\Users\Faye Wang\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\OpenCodeFeishuPassive.lnk`
- authoritative desktop/archive shortcuts:
  - `D:\格外可爱的\Desktop\OpenCodeFeishuPassive.lnk`
  - `D:\Program Files Dev\快捷方式归档\OpenCode\OpenCodeFeishuPassive.lnk`
- all launcher shortcuts should invoke:
  - `cmd.exe /c chcp 65001 >nul && "C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "D:\Program Files Dev\opencode-feishu\passive\scripts\opencode_feishu_passive_ctl.ps1" auto`

### UX contract

- cold start:
  - visible window
  - about 10 seconds settle/countdown delay
  - start the daemon
  - auto-close about 3 seconds later
- second launch while already running:
  - enter interactive control menu
  - do not flash-exit

### Script ownership

- control entry:
  - `passive/scripts/opencode_feishu_passive_ctl.ps1`
- autostart executor:
  - `passive/scripts/opencode_feishu_passive_autostart.ps1`
- compatibility wrapper:
  - `passive/scripts/opencode_feishu_passive_autostart.bat`
- installation helpers:
  - `passive/scripts/install-startup.ps1`
  - `passive/scripts/uninstall-startup.ps1`
  - `passive/scripts/create-shortcuts.ps1`

### Safety rules

- preserve duplicate-start protection
- `start.ps1` may skip if passive is already running
- do not pre-write `.passive.lock` before daemon startup
- let the daemon own `.passive.lock`
- if the daemon is already running, the launcher should enter menu mode instead of trying a second start

### Troubleshooting order

1. inspect the Startup `.lnk` target and working directory
2. inspect `opencode_feishu_passive_ctl.ps1` `auto` flow
3. inspect actual live `node ... passive\\dist\\index.js` process
4. inspect `.passive.pid` and `.passive.lock`
5. only then decide whether the issue is shortcut drift, wrapper drift, stale state, or daemon failure

If older sections below still describe Task Scheduler as the main passive startup mechanism, treat this override section as the current truth.

## 概述

被动模式是一个**完全独立**的 Node.js 服务，不依赖 opencode-feishu 插件，实现：

- **主动推送**：检测 `opencode.db` 变化，发卡片到飞书通知 AI 状态
- **零 AI 算力**：完全基于 DB 查询和 Feishu API 调用，不消耗 OpenCode AI token
- **独立配置**：使用 `passive/feishu.json`，不依赖插件目录

## 架构 (事件驱动分层)

```
┌───────────────────────────────────────────────────────────┐
│  分层事件驱动架构                                           │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  第1层 (触发器)   fs.watch 监控 opencode.db 修改事件        │
│                  + opencode.db-wal / -shm                 │
│                  → CPU ≈ 0% (操作系统回调)                 │
│                       │                                   │
│                       ▼                                   │
│  第2层 (闸门)     防抖 2s，批处理快速连续写入               │
│                  校验 DB mtime 是否真正变化                 │
│                  排除误触发                                │
│                       │                                   │
│                       ▼                                   │
│  第3层 (处理器)   执行完整 poll() 逻辑                     │
│                  DB 查询 → 状态比较 → 飞书卡片推送          │
│                  SQLite 连接复用 (WAL 模式, 不反复开关)      │
│                                                           │
│  安全网: 每 120s 的 fallback 检查 (fs.watch 遗漏兜底)       │
└───────────────────────────────────────────────────────────┘
```

### vs 旧架构

| 指标 | 旧架构 (setInterval 20s) | 新架构 (事件驱动) |
|------|------------------------|------------------|
| 空闲 CPU | ~15-17% (持续轮询) | ≈ 0% (仅回调触发) |
| DB 连接 | 每次 poll 关闭/重开 | 永久复用 (WAL) |
| 轮询间隔 | 固定 20s (硬编码) | 事件触发 + 120s 兜底 |
| 配置方式 | 不可配 | 环境变量 / CLI 参数 |

## 文件结构

```
passive/src/
├── index.ts         # 入口，初始 poll + 事件驱动主循环
├── watcher.ts       # 分层文件监控器 (fs.watch + 防抖 + fallback)
├── config.ts        # 配置 (含 env/CLI 参数支持)
├── paths.ts         # 路径常量
├── db.ts            # SQLite 查询 (WAL 模式, 连接复用)
├── state-machine.ts # 状态检测
├── notify.ts        # 卡片构建 + 发送
├── sender.ts        # Feishu API
├── card-dsl.ts      # DSL → Card JSON
├── logger.ts        # 日志
├── markdown.ts      # Markdown 截断
└── utils.ts         # TtlMap
```

## 状态机

| transition | 条件 | 卡片标题 |
|---|---|---|
| `working→waiting` | `part.type=text` 或 `tool.state.status=completed` 且之前为 working | ❓ OpenCode 需要你处理 |
| `waiting→working` | 再次出现 tool(running) 或 reasoning | 🔄 OpenCode 正在继续 |
| `any→done` | 运行期内观察到真实完成，并通过静默窗口复核 | ✅ OpenCode 任务完成 |

完成卡不能再简单地“只认 `session.time_archived`”，因为用户真实使用 `opencode` 的对话式任务可以完成于 active session 而不立刻 archive；但也不能回退到“看到 active session 的 `step-finish(stop)` 就立刻发完成卡”，那样会重新引发历史 session 批量补发。当前正确边界是：

- archived session：
  - archive 进入 pending
  - 静默窗口后再复核 archive 仍存在
  - 且 stop 证据覆盖 archive
  - 才允许发 `done`
- active session：
  - 只对**当前 daemon 运行期内新观察到**的 stop 建立 pending
  - 静默窗口内若出现新的用户消息或新的 assistant 输出，取消 pending
  - 只有静默窗口结束且没有继续输出时，才允许发 `done`

这条边界的目标是：
- 覆盖用户真实的对话式“已完成但未 archive”场景
- 同时继续压住历史完成重放

## 2026-06-06 运行态校验补充

- `passive/src/index.ts` 与 `passive/dist/index.js` 当前口径都是：active session 只 `markSeen(...)`，**不发送中间 reply 卡**。
- 如果日志里仍出现 `kind=reply` / `💬 OpenCode 新回复`，先不要误判为源码回退；本机已实证过一种更常见情况：
  - 旧 daemon 进程在 `build` / `git pull` 之前启动；
  - 后来工作树和 `dist/` 已更新成“禁 reply”版本；
  - 但旧进程没重启，仍按旧内存代码继续推 `reply`。
- 本机这次实证：
  - 旧进程：`PID 22596`，启动于 `2026-06-06 09:34:02`
  - 新代码构建时间：`passive/dist/index.js` `LastWriteTime = 2026-06-06 16:11:29`
  - 旧进程直到 `2026-06-06 16:24:25` 仍在写 `kind=reply`
  - `2026-06-06 16:52:50` 重启为 `PID 23736` 后，新日志不再出现新的 `reply`
- 因此排查顺序必须是：
  1. 看运行进程 PID / 启动时间
  2. 看 `dist/index.js` 的 `LastWriteTime`
  3. 先 `npm run build`
  4. 再 `pwsh -File passive/scripts/start.ps1 -Action restart`
  5. 再用 `lark-cli` 真实触发一轮并看 **重启时间之后** 的日志
- 验证金标准：
  - 进程命令行应为：`node ...\passive\dist\index.js`
  - `2026-06-06.log` 在新 `starting {"pid":...}` 之后，只允许出现 `done`，不应再出现新的 `kind=reply`

## 2026-06-06 运行态校验再补充：日志必须带 PID

- 同一个飞书 app / chat 里，可能同时出现：
  - passive 完成卡
  - 用户自己活跃中的 `opencode` 会话结果
  - NeoMei / 主插件其他消息
- 仅凭“同一聊天里出现了卡片”或“卡片长得像 passive”不足以证明就是 passive 当前进程发的。
- 因此 passive 日志现在必须带：
  - `[pid=<node pid>]`
- 审计顺序必须升级为：
  1. 先看最新 `starting {"pid":...}` 行
  2. 再只采信同一 PID 的后续 `[push]` / `poll:` 日志
  3. 没有 PID 标签的旧窗口结论，不能拿来指控当前新进程
- 这条规则是为了避免把用户自己正在运行的 `opencode` 会话输出，误判成 passive reply/card 误发。

## 2026-06-06 19:30 收口补充

- 新增运行时保护：
  - `passive/src/index.ts`
    - startup 首轮即 `saveNotifiedState(state)`，这样即使当次没有 transitions，也会把内存中规范化后的 state 回写磁盘
  - `passive/src/notify.ts`
    - done 卡移除了 `<at id=all></at>`，后续若再出现误判 done，也不会形成连续 `@` 轰炸
- 新运行窗口：
  - `npm run build`
  - `pwsh -File passive/scripts/start.ps1 -Action restart`
  - 新 PID：`6508`
  - 启动时间：`2026-06-06 19:30:17 +08:00`
- 这次重启后的硬证据：
  - `notify-state.json` 已被成功规范化写回，不再保留 legacy `lastDoneTime` / `pendingDoneTime`
  - `2026-06-06.log` 在 `PID 6508` 启动后，当前采样仅见：
    - startup
    - DB opened
    - lock acquired
    - `poll: sessions=125 transitions=0`
    - `[cycle] pushes=0`
  - 截至当前采样，没有新的 `kind=reply`
- 审计口径更新：
  - `19:23` / `19:26` / `19:29` 的 reply 证据只能归属于旧窗口，不得继续拿来指控 `PID 6508`
  - 但 `PID 6508` 仍需下一次真实用户事件验证，才能宣布 done-only 运行态真正恢复

## 2026-06-06 19:42 反例补充：不要再把静态代码口径当成运行态结论

- 上一节里“`PID 6508` 当前采样没有新的 `kind=reply` / `notify-state.json` 已规范化回写”的判断，随后已被**同一运行窗口**的新证据推翻。
- 当前已坐实的反例：
  - `PID 6508` 启动时间：`2026-06-06 19:30:17 +08:00`
  - 该窗口内真实出现：
    - `2026-06-06T19:37:48.482+08:00` `kind=reply`
    - `2026-06-06T19:39:58.769+08:00` `kind=reply`
    - `2026-06-06T19:37:49` 到 `19:38:15` 之间连续 `35` 条历史 `done` 重放
- 同时，`passive/logs/notify-state.json` 在这次采样时也明确不是“纯新 schema”：
  - 虽有 `_daemonStartedAt`
  - 但 session 条目仍真实包含 legacy 字段：
    - `lastDoneTime`
    - `pendingDoneTime`
- 因此新增硬规则：
  1. **不要** 因为 `passive/src/index.ts` 看起来只写 `done`，就宣布 runtime 已 done-only。
  2. **不要** 因为 `passive/src/notify-state.ts` 里有 `sanitizeEntry()`，就宣布磁盘 state 已稳定规范化。
  3. 每次结论都必须同时满足：
     - 当前最新 PID 启动线之后，没有新的 `kind=reply`
     - 当前 `notify-state.json` 抽样确认只落 `pendingDoneAt`，不再落 `lastDoneTime` / `pendingDoneTime`
  4. 若两者任一不满足，只能下结论为：
     - “源码口径如此，但运行态仍未恢复”
- 实操顺序升级为：
  1. 先看当前 passive node PID 和启动时间
  2. 再只看该启动时间之后的日志
  3. 再直接读取 `passive/logs/notify-state.json` 实际落盘字段
  4. 最后才允许写“已恢复 / 已修复”类结论

## 2026-06-06 20:27 审计补充：区分“单实例已改善”和“历史完成已修复”

- 当前已确认改善的范围只有：
  - `passive/scripts/start.ps1` 连续执行两次时，第二次会跳过，复用当前 PID
  - 也就是“重复手动启动直接多开第二实例”这层已有正向证据
- 当前**尚未**确认已修复的范围：
  - `notify-state.json` 里仍可观察到一批数据库 `time_archived IS NULL` 的 active session
  - 其 state 条目却仍带 `lastSeenArchiveTime > 0`
  - 这说明 startup/state 语义仍可能把 active session 误保留为“曾归档”
- 因此从现在起，审计措辞必须分开写：
  1. 可以说：`当前未发现多开`
  2. 可以说：`新窗口启动后暂未复现 transitions=36`
  3. 不可以说：`历史完成狂推已彻底修复`
- 只有当下面两条同时满足，才允许升级结论：
  - 新窗口长时间在线后仍无新的历史 done 批量重放
  - `notify-state.json` 中 active session 不再残留 `lastSeenArchiveTime > 0`

## 2026-06-06 20:34 运行态再更新：startup priming 污染已被受控重启验证打掉

- 最新受控重启窗口：
  - PID：`7292`
  - 启动时间：`2026-06-06 20:34:14 +08:00`
- 本轮新增修复点：
  - `passive/src/index.ts`
  - startup 首轮不再沿用普通 transition poll
  - 改为单独 snapshot priming：
    - active sessions -> `lastSeenArchiveTime = 0`
    - archived sessions -> 仅记录真实 archive 快照
- 验证结果：
  - 启动日志：`poll: sessions=127 transitions=0`
  - `notify-state.json` 抽样中，原先污染的 active session 已恢复为：
    - `lastSeenArchiveTime: 0`
  - 汇总计数：`archiveTrackedCount = 0`
- 这意味着：
  - “startup 会把 active session 批量写成 archived” 这一主因，在当前新窗口已被修掉
  - 当前可以把结论升级为：
    - `当前未多开`
    - `startup 首轮未重放历史完成`
    - `active-session archive 污染已在受控重启中验证修复`
- 仍保留最后一道审计谨慎项：
  - 还需要至少一次真实 archive/完成场景继续观察
  - 再决定是否把结论升级为“历史 done 重放已长期验证通过”

## 2026-06-06 20:59-21:00 新补充：same-poll stop 漏建 pending 已实证修复

- 本轮真正剩余的 bug 已定位为：
  - active session 在**同一轮 poll**里同时出现 assistant 文本和 `step-finish(reason=stop)` 时，
  - 旧逻辑会命中 `hasNew && latest.text.trim()` 分支后直接 `continue`
  - 结果只 `markSeen(...)`，不会写 `pendingDoneAt`
  - 后果就是：
    - 日志看起来像“看到了新回复”
    - `notify-state.json` 也会更新 `lastSeenStopTime`
    - 但完成闸门从未真正建立，所以后续永远不会发完成卡
- 当前修复点：
  - 文件：`passive/src/index.ts`
  - 在 `hasNew && latest.text.trim()` 分支里：
    - 先 `markSeen(...)`
    - 再判断：
      - `stopAdvancedNow`
      - `stopObservedDuringRuntimeNow`
      - `noPostStopPartsNow`
    - 若三者都满足，则直接写：
      - `entry.pendingDoneAt = latestStopTime`
    - 并记录调试语义：
      - `[active:pending:same-poll]`
- 当前运行态验证窗口：
  - `npm run build`
  - `pwsh -File passive/scripts/start.ps1 -Action restart`
  - 新 PID：`9768`
  - 启动时间：`2026-06-06 20:59:23 +08:00`
- 正样本已固定：
  - 触发命令：`opencode run "reply with exactly: passive pending check 2"`
  - session：`ses_162fb8228ffeGXMvIvw3NU6W04`
  - DB 证据：
    - user text
    - assistant `step-start`
    - assistant text: `passive pending check 2`
    - assistant `step-finish(reason=stop)`
    - `time_archived = null`
- state 落盘证据：
  - `lastSeenText: "passive pending check 2"`
  - `lastSeenStopTime: 1780750781794`
  - `pendingDoneAt: 1780750781794`
  - `lastPushedAt: 0`

## 2026-06-06 22:54-23:05 新补充：测试完成卡与多 PID 解释边界

- `passive-watch-live-check-1104` 这张完成卡本轮已用 DB + passive 专用日志重新取证：
  - 不是误判
  - 不是历史重放
  - 是当前 live passive daemon `PID 1104` 的真实 `done` 推送
- 固定证据链：
  - `passive/logs/2026-06-06.log`
    - `22:54:48` `[push] kind=done session=ses_162925f3...`
  - `opencode.db` 该 session 分片：
    - user text
    - assistant text `passive-watch-live-check-1104`
    - assistant `step-finish(reason=stop)`
  - `passive/logs/notify-state.json`
    - `lastSeenStopTime = 1780757673774`
    - `lastDoneStopTime = 1780757673774`
    - `lastPushedAt = 1780757689802`
- 这条结论的实际含义：
  - 对于“只让 passive 推送真正完成”的目标，当前实现认为：
    - 只要 session 在 DB 中出现了当前运行期内的 assistant text + `step-finish(stop)`，且静默窗口通过，就属于完成
  - 所以这类极短测试 prompt 仍会被当作“真实完成任务”
  - 若产品上不希望测试标题也产生正式完成卡，应单独设计“测试会话过滤/白名单”策略，而不是继续把它归因为完成判定 bug

- 同时，本轮也把“今天为什么总换 PID”这件事重新定性：
  - 当前证据支持：
    - 多次 `PID` 变化主要来自重复执行 `start.ps1` / `restart.ps1`
    - 属于**单实例重启换号**
  - 当前不支持：
    - “现在仍有多个 passive node 进程同时在跑”
- 现场核对口径：
  - 当前 live passive 只有一个：
    - `PID 1104`
    - 启动于 `2026-06-06 22:53:02 +08:00`
  - `OpenCodeFeishuPassive` 计划任务状态为 `Ready`
    - 表示已注册
    - 不表示此刻在循环自拉起
- 后续排障顺序应固定为：
  1. 先看当前 node 进程数是否真的 `> 1`
  2. 再看最近是否刚执行过 start/restart 脚本
  3. 最后才讨论是否存在计划任务或守护脚本误触发
- 这条证据已足够证明：
  - “same-poll 文本+stop 时 pending 丢失” 这个核心 bug 已被打通
  - 当前还**不能**直接宣布“完成卡链路完全恢复”
  - 因为还需要等待 5 分钟静默窗后，确认：
    - 只发 1 张 `done`
    - 不回放旧 session
    - 不在静默窗内提前发卡

## 2026-06-06 21:07-21:13 新补充：调试模式与 pending 自动唤醒已落地

- 新增调试模式入口：
  - `passive/scripts/start.ps1 -Mode debug`
  - 默认会带：
    - `--complete-grace-ms 15000`
  - 启动推送与 runtime startup 日志现在都会明确记录：
    - `mode=debug`
    - `archiveGraceMs=15000`
    - `debugMode=true`
- 新增参数化完成冷却窗：
  - `passive/src/config.ts`
  - 环境变量：`FEISHU_COMPLETE_GRACE_MS`
  - CLI 参数：`--complete-grace-ms`
  - 生产默认值仍是 `300000 ms`
- 完成卡模板重新补厚：
  - `passive/src/notify.ts`
  - 完成卡不再只是“会话 + session”
  - 现在至少包含：
    - 会话标题
    - 最后一条回复正文（`truncateMarkdown(...)` 后展示）
    - 脚注：结束时间 / 最后回复时间 / session
- 新发现并已修复的底层问题：
  - 旧逻辑即使写入了 `pendingDoneAt`
  - 也仍然依赖“下一次 DB 文件变化”或 `120s fallback` 才会再次 poll
  - 这会导致：
    - debug 模式虽然把 grace 降到 `15s`
    - 但真实发卡时间仍可能漂到下一个外部事件
- 当前修复点：
  - `passive/src/index.ts`
  - 在每次 poll 结束后，根据 state 中最早的 `pendingDoneAt + COMPLETE_GRACE_MS`
    - 主动 `setTimeout(...)` 预约下一次自唤醒 poll
  - watcher 事件与定时唤醒共用同一 `triggerPoll()`，避免并发 poll
- 运行态验证：
  - PID `15420`
    - debug 模式 `15s`
    - 样本：`ses_162f3ec96ffeM0G6VlcXc5uzbm`
    - `pendingDoneAt` 建立成功
    - 但该窗口仍是在后续事件到来时才发出 done，坐实了“缺少到点自唤醒”的问题
  - PID `2704`
    - 含自动唤醒修复后的 debug 窗口
    - 样本：`ses_162efb9a2ffe30jKsIN2ArDP7X`
    - assistant text：`passive auto wake rich test`
    - `pendingDoneAt = 1780751553046`
    - `lastPushedAt = 1780751569101`
    - 日志：
      - `21:12:30` startup
      - `21:12:35` sample observed
    - `21:12:48` `[push] kind=done ... text_len=27`
    - 这次 done 发卡与新的 DB 外部变化无关，证明到点自动唤醒已生效

## 2026-06-06 21:14-21:15 新补充：完成卡 @all 恢复，且不再被 sender 剥离

- 用户补充需求：`done` 卡需要 `@所有人`
- 当前修复点：
  - `passive/src/notify.ts`
    - 完成卡 sections 顶部重新加入：
      - `<at id=all></at>`
  - `passive/src/sender.ts`
    - 删除对 interactive card payload 的全局 `stripEveryoneMentions(...)`
    - 原因：
      - passive 已经严格 done-only
      - 再全局剥离 `@all` 会把用户明确要求的完成提醒一并吃掉
      - reply card 本身仍由 `BLOCKED_REPLY_CARD_TITLES` 阻断，不会因为放开 `@all` 而回到中间卡
- 运行态验证窗口：
  - PID：`23980`
  - debug 模式：`archiveGraceMs=15000`
  - 样本：`ses_162ed8c34ffe0znQw1ycasQc0U`
  - assistant text：`passive all mention final test`
  - `pendingDoneAt = 1780751699289`
  - `lastPushedAt = 1780751715308`
  - 日志：
    - `21:14:53` startup
    - `21:15:14` `[push] kind=done ... text_len=30`
    - `21:15:15` sent
- 当前可确认的结论：
  - debug 模式下：
    - 15 秒冷却窗仍然生效
    - 到点自动唤醒仍然生效
    - 完成卡正文仍带最后回复文本
    - sender 不再剥离 `@all`

## 目录结构

```
passive/
├── feishu.json         # 独立配置（appId/appSecret，仓库内提交）
├── src/
│   ├── index.ts         # 入口，事件驱动主循环
│   ├── watcher.ts       # 分层文件监控器 (fs.watch + 防抖 + fallback)
│   ├── config.ts        # 加载 feishu.json，配置常量 (支持 env/CLI)
│   ├── paths.ts         # 路径常量（含 STANDALONE_CONFIG）
│   ├── db.ts            # SQLite 查询 (WAL 模式, 连接复用)
│   ├── state-machine.ts # 状态检测与转换
│   ├── notify.ts        # 卡片构建 + 发送
│   ├── sender.ts        # Feishu API（token + 发送）
│   ├── card-dsl.ts      # DSL → Card 2.0 JSON
│   └── utils.ts         # TtlMap
├── scripts/             # 启动/停止/安装脚本
├── package.json
└── tsconfig.json
```

## 构建与运行

```bash
cd passive
npm install
npm run build
npm start
```

## 运行时配置 (环境变量 / CLI 参数)

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `--debounce-ms` | `FEISHU_DEBOUNCE_MS` | `2000` | fs.watch 触发后防抖等待(ms) |
| `--fallback-ms` | `FEISHU_FALLBACK_MS` | `120_000` | fallback 定时检查间隔(ms) |
| `--poll-ms` | `FEISHU_POLL_MS` | `20_000` | (保留)强制轮询间隔，覆盖事件驱动 |
| `FEISHU_PROXY` | `FEISHU_PROXY` | `http://127.0.0.1:10809` | Feishu API 代理地址 |

所有参数最小为 1000ms。示例:
```bash
# 加大防抖和 fallback 间隔，进一步降低资源
FEISHU_DEBOUNCE_MS=5000 FEISHU_FALLBACK_MS=300000 npm start

# 用 CLI 参数
node dist/index.js --debounce-ms=3000 --fallback-ms=180000
```

## 依赖文件

| 文件 | 来源 | 用途 |
|---|---|---|
| `passive/feishu.json` | 本仓库（独立配置） | appId / appSecret |
| `~/.local/share/opencode/opencode.db` | OpenCode | session / part 表查询 |

## 与原插件的关系

| | opencode-feishu 插件 | passive 模式 |
|---|---|---|
| 触发方式 | 飞书消息→AI→飞书 | fs.watch DB 事件驱动 |
| AI 算力 | 消耗 | 不消耗 |
| 状态检测 | WebSocket 事件 | fs.watch → DB 查询 |
| 空闲 CPU | ≈ 0% (事件驱动) | ≈ 0% (事件驱动) |
| 发卡片能力 | feishu_send_card tool | Feishu API 直接调 |
| 可独立运行 | 否（依赖 opencode） | **是** |
| 配置位置 | `~/.config/opencode/plugins/feishu.json` | `passive/feishu.json` |

> **注意**：被动模式不依赖 opencode-feishu 插件。插件可以卸载，不影响被动模式运行。

## 开机自启动

本机有 3 个飞书 bot 开机启动项，分别服务不同项目：

| 启动项 | 机制 | 目标 | 用途 |
|--------|------|------|------|
| `OpenCodeFeishuPassive` | Task Scheduler | `passive/scripts/start.ps1` | **opencode-feishu** 被动模式 daemon |
| `OpenCodeFeishuPassive.lnk` | Startup 文件夹 | `passive/scripts/opencode_feishu_passive_autostart.bat` | 同上（备用启动方式） |
| `feishu_bot_autostart.lnk` | Startup 文件夹 | `SunCodexClaw/tools/5/feishu_bot_autostart.bat` | **SunCodexClaw** 的飞书 bot |

### Task Scheduler 详情

- **任务名**：`OpenCodeFeishuPassive`
- **触发器**：用户登录时（AtLogOn）
- **失败重启**：最多 5 次，间隔 1 分钟
- **安装脚本**：`scripts/install-startup.ps1`
- **卸载脚本**：`scripts/uninstall-startup.ps1`

> **注意**：`feishu_bot_autostart.lnk` 是 SunCodexClaw 项目的，与 opencode-feishu 无关，**不要删除**。

## 独立配置

被动模式使用 `passive/feishu.json` 作为唯一配置文件：

```json
{
  "appId": "cli_xxx",
  "appSecret": "xxx"
}
```

此文件已提交到仓库（私库），克隆后即可使用，无需额外配置。

## 历史事故：feishu.json 丢失（2026-06-04）

### 原因

旧版 `config.ts` 从 `~/.config/opencode/plugins/feishu.json`（插件目录）读取配置。卸载 opencode-feishu 插件后该文件被删除，daemon 无法启动。

### 已修复

- `config.ts` 改为只读 `passive/feishu.json`（独立配置），不再依赖插件目录
- 配置文件随仓库提交，克隆即用

### 恢复步骤（如需手动恢复）

```powershell
# 创建配置文件
@{ appId = "cli_aa943aedd723dbc0"; appSecret = "<secret>" } | ConvertTo-Json |
  Set-Content "D:\Program Files Dev\opencode-feishu\passive\feishu.json"

# 重启 daemon
& "D:\Program Files Dev\opencode-feishu\passive\scripts\start.ps1" -Action restart

# 验证
& "D:\Program Files Dev\opencode-feishu\passive\scripts\status.ps1"
```

## 2026-06-06 当前稳定口径补充

- 若用户说“疯狂弹 @”，先区分两层伤害：
  1. 是否仍有 `reply` 中间卡误发
  2. done 卡是否还带 `@all`
- 当前 repo 新收口：
  - `passive/src/notify.ts`
    - done 卡已移除 `<at id=all></at>`
  - `passive/src/index.ts`
    - startup 首轮即保存规范化 state，避免旧 `notify-state.json` 字段长期滞留
- 当前诊断口径：
  - 旧窗口里的 `kind=reply` 不能继续用来指控新 PID
  - 必须看当前 daemon startup 之后的日志窗口
  - 还要同时看 `notify-state.json` 是否已清掉 legacy `lastDoneTime` / `pendingDoneTime`
- 2026-06-06 19:30 验证结果：
  - 新 PID `6508`
  - `notify-state.json` 已成功规范化回写
  - 截至采样点，新窗口后未见新的 `kind=reply`
  - 但这仍只算“当前窗口暂时干净”，后续还要用真实用户事件再次验证 done-only 运行态

## 2026-06-06 22:29 新补充：done-only 还必须防重复 done

- passive 当前真实状态文件路径是：
  - `D:\Program Files Dev\opencode-feishu\passive\logs\notify-state.json`
  - 不要误查 `~/.config/opencode/notify-state.json`
- 新抓到的当前运行态问题不是历史噪声：
  - 在同一 live PID `23980` 窗口里
  - 同一 session `ses_16382a68...`
  - 出现了连续 3 次 `kind=done`
  - 日志时间：`21:22:53`、`21:24:17`、`21:39:03` UTC+8
- 这说明：
  - done-only 不只是“去掉中间 reply”
  - 还必须防“同一完成证据窗口重复补发 done”
- 当前修复方向已落在 `src/index.ts`：
  - 发 `done` 之前，重新加载磁盘 `notify-state.json`
  - 若 fresh state 对同一 session 已满足：
    - `lastPushedAt > 0`
    - `lastSeenTime >= 当前 event time`
    - `lastSeenStopTime >= 当前 stop time`
  - 则跳过再次发卡，只同步 state
- 注意边界：
  - 这个闸门是拦同一完成窗口的重复发卡
  - 不是禁止同一 session 后续新 user turn 再发新的完成卡

## 2026-06-06 21:59 新窗口 live 复核

- 受控重启：
  - `powershell -ExecutionPolicy Bypass -File passive/scripts/start.ps1 -Action restart -Mode debug`
  - 新 PID：`22912`
  - 启动时间：`2026-06-06 21:59:05 +08:00`
- 启动后第一轮关键观察：
  - 未出现 startup 立即历史 done 批量重放
  - 日志仅见：
    - `pushes=0 sessions=137 status=startup`
    - 随后进入 `running`
- 最小 live 场景：
  - 触发：`opencode run "reply with exactly: passive-dedupe-live-check-22912"`
  - session：`ses_162c4a5f...`
  - title：`Exact string repetition test`
  - 日志：
    - `21:59:52` `push kind=done`
    - `21:59:53` `push sent`
  - 额外等待约 `25s` 复查，同一 session 未见第二次 `done`
- 当前口径：
  - dedupe 闸门已经拿到一次正向 runtime 证据
  - 但“大任务/同 session 多轮长跑”是否完全压住重复 done，还需要继续观察真实窗口，不能因为这一次最小样本就宣布长期稳定
- 记录口径时要明确“修复边界”：
  - 现在可以说：当前 PID `22912` 启动后未重放历史 done，且最小 live 样本只发了 1 次 done
  - 还不能说：所有长会话、多轮同 session、所有异常 token/重启窗口都已经彻底解决
- Repo 边界补充：
  - `D:\Program Files Dev` 不是 git 根
  - `opencode-feishu`、`opencode-feishu-neomei`、`.codex/skills` 需要分别提交推送

## 2026-06-06 22:16 分层激活 / 边界调试补充

- passive 当前不是固定 `20s` 轮询：
  - `watchDebounceMs = 2000`
    - DB 文件变化驱动，约 `2s` 去抖后处理
  - `fallbackCheckMs = 120000`
    - 长时间没变化时，`120s` 才做一次保底检查
  - `archiveGraceMs = 15000`
    - debug 模式下的完成冷却窗口，不是轮询周期
- 这套属于分层激活：
  - 有变化时快速响应
  - 没变化时低频保底
  - 资源友好，不是粗暴高频轮询
- 当前推荐的边界调试真相源：
  - 日日志：`passive/logs/YYYY-MM-DD.log`
  - 持久状态：`passive/logs/notify-state.json`
- 7 天滚动不要只理解成“删旧文件名”：
  - `YYYY-MM-DD.log` 这类按天文件，本身已经按内容分日，保留 7 天等于内容窗口 7 天
  - 但 `passive.err.log` / `passive.out.log` / `passive.log` 这类单文件日志，也必须做内容级裁剪
  - 本仓现口径应保持为：
    - 日志文件：删 7 天前整文件
    - 单文件日志：按行首时间戳裁剪，仅保留最近 7 天内容
- 新增日志原因码：
  - `active:no-done-evidence`
  - `active:no-done-transition`
- 这两类日志用来回答：
  - 候选完成证据是什么时间出现的
  - quiet window 内是否又恢复输出 / 继续 tool
  - 为什么这次没有发完成卡
- 2026-06-06 22:32 再确认一条硬边界：
  - 用户看到“这一段已经像结论了”，不等于 passive 应该立刻发 done。
  - 如果同一 session 后面又继续产生新 `part`，或者最近终止事件只是 `step-finish(reason=tool-calls)`，则该轮仍视为活跃。
  - 只有满足以下条件才算 active session done：
    - 最近完成证据是 `step-finish(reason=stop)`
    - 该 `stop` 之后没有更晚的 `part`
    - quiet window 已走完
  - 这条规则是长会话判定基线，不要再用“看到一句总结”替代数据库边界。
- 状态字段语义也已明确拆分：
  - `lastSeenTime` / `lastSeenStopTime`
    - 只是“观察到过”的时间
  - `lastDonePartTime` / `lastDoneStopTime`
    - 才是“这轮 done 已经发过”的 dedupe 边界
  - 否则同一长会话的后续 user turn，容易被旧的 seen 状态误压成“已推送过”
- 新的长停顿排查字段应优先看：
  - `pendingReason`
    - 这次 quiet window 是怎么进入的：`same-poll-stop` / `separate-stop` / `startup-catchup` / `archive`
  - `quietForMs`
    - 到日志记录当下，实际已经安静了多久
  - `resumeAfterStopMs`
    - 如果 done 被取消，stop 后过了多久又恢复输出
  - `resumedType` / `resumedReason` / `resumedTool`
    - 恢复活跃的直接原因是什么

## 2026-06-06 22:21 status 脚本口径修复

- 如果 `passive` 新 PID 明明已经启动，但 `start.ps1 -Action status` 还显示旧 PID，不要先怀疑 daemon 本体。
- 本机真实踩到的根因是：
  - `status` 之前会把实时进程扫描结果和旧 `.passive.pid` / `.passive.lock` 混在一起显示
  - 导致短窗口内可能看到“旧 PID not alive”之类的误导输出
- 现口径：
  - `Show-Status` 优先以 `Find-AllDaemonPids()` 的实时扫描为准
  - 一旦扫到真实 daemon，会立刻回写 `.passive.pid` 与 `.passive.lock`
  - 只有完全扫不到 live daemon 时，才回退到旧 pid/lock 文件做 stale 提示

## 2026-06-06 22:48 延迟 done 观察链路补充

- 这次用户给出了一个可对时的体感延迟样本：
  - 会话：`查找即征即退进项分析仓库`
  - 用户看到完成大约在 `22:42:45`
  - passive 完成卡收到时间在 `22:44`
- 当前排查结论要分清：
  1. 不是 quiet window `15000ms` 本身过长
  2. 而是 passive 较晚才第一次观察到这次 `stop`
- 为了把这类问题从“猜”变成“直接看日志”，当前 repo 新增 watcher 诊断层：
  - `passive/src/watcher.ts`
    - 不再只监听 DB 目录
    - 现在同时监听：
      - `opencode.db`
      - `opencode.db-wal`
      - `opencode.db-shm`
      - 以及 DB 所在目录
  - watcher 回调新增字段：
    - `source=dir|file|fallback`
    - `event`
    - `filename`
    - `signatureBefore`
    - `signatureAfter`
    - `changed`
- `passive/src/index.ts` 对 done 观察延迟也新增了运行态字段：
  - `stopObservedDelayMs`
  - `triggerSource`
  - `triggerEvent`
  - `triggerChanged`
  - `triggerObservedDelayMs`
- 这批字段的目标不是“修饰日志”，而是下次再出现：
  - “22:42 已完成，22:44 才推送”
  时能直接区分：
  - 是 `file` / `dir` watcher 及时唤醒了，只是 quiet window 在等
  - 还是 watcher 没打到，最后靠 `fallback` 120s 兜底才观察到
- 另外一个顺手修正：
  - `notify-state.ts` 成功保存状态的日志：
    - `[state] save ok`
  - 现在应是 `INFO`
  - 不是 `ERROR`
  - 如果运行时还看到 `save ok` 以 error 级别出现，优先怀疑旧 daemon / 旧构建还在跑
