# opencode-feishu Passive Mode

## 概述

被动模式是一个**完全独立**的 Node.js 服务，不依赖 opencode-feishu 插件，实现：

- **主动推送**：轮询 `opencode.db`，检测 AI 状态变化，主动发卡片到飞书
- **零 AI 算力**：完全基于 DB 查询和 Feishu API 调用，不消耗 OpenCode AI token
- **独立配置**：使用 `passive/feishu.json`，不依赖插件目录

## 架构

```
opencode.db (轮询)
       │
       ▼
┌─────────────────┐
│ passive/src/    │
│                 │
│ index.ts        │ ────────→ Feishu API
│ state-machine   │ 状态机     (appId/appSecret
│ db.ts           │            from feishu.json)
│ notify.ts       │ 通知
│ sender.ts       │ 发卡
│ card-dsl.ts     │ 卡片 DSL
└─────────────────┘
```

## 状态机

| transition | 条件 | 卡片标题 |
|---|---|---|
| `working→waiting` | `part.type=text` 或 `tool.state.status=completed` 且之前为 working | ❓ OpenCode 需要你处理 |
| `waiting→working` | 再次出现 tool(running) 或 reasoning | 🔄 OpenCode 正在继续 |
| `any→done` | `session.time_archived` 不为空 | ✅ OpenCode 任务完成 |

## 目录结构

```
passive/
├── feishu.json         # 独立配置（appId/appSecret，仓库内提交）
├── src/
│   ├── index.ts         # 入口，轮询循环
│   ├── config.ts        # 加载 feishu.json，配置常量
│   ├── paths.ts         # 路径常量（含 STANDALONE_CONFIG）
│   ├── db.ts            # SQLite 查询封装
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

## 依赖文件

| 文件 | 来源 | 用途 |
|---|---|---|
| `passive/feishu.json` | 本仓库（独立配置） | appId / appSecret |
| `~/.local/share/opencode/opencode.db` | OpenCode | session / part 表查询 |

## 与原插件的关系

| | opencode-feishu 插件 | passive 模式 |
|---|---|---|
| 触发方式 | 飞书消息→AI→飞书 | DB 轮询 |
| AI 算力 | 消耗 | 不消耗 |
| 状态检测 | WebSocket 事件 | part 表轮询 |
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
