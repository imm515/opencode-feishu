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
