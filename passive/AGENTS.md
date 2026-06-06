# opencode-feishu Passive Mode

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
| `any→done` | `session.time_archived` 不为空 | ✅ OpenCode 任务完成 |

完成卡当前以 `session.time_archived` 作为唯一可信完成信号。不要再把 active session 里的 `step-finish(stop)` 当作完成推送条件，否则会出现“实际上还没结束，但先弹完成卡”的误报。

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
