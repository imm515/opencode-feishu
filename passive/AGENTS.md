# opencode-feishu Passive Mode

## 概述

被动模式是一个独立的 Node.js 服务，替代 opencode-feishu 插件原有的"飞书→OpenCode→飞书"响应式链路，实现：

- **主动推送**：轮询 `opencode.db`，检测 AI 状态变化，主动发卡片到飞书
- **零 AI 算力**：完全基于 DB 查询和 Feishu API 调用，不消耗 OpenCode AI token
- **插件身份**：复用 `~/.config/opencode/plugins/feishu.json` 的 appId/appSecret

## 架构

```
opencode.db (轮询)          opencode-feishu (插件)
       │                           │
       ▼                           ▼
┌─────────────────┐          ┌─────────────────┐
│ passive/src/    │          │ 被动模式        │
│                 │          │                 │
│ index.ts        │ ──────── │→ Feishu API     │
│ state-machine   │ 状态机   │  (同一 appId)   │
│ db.ts           │          │                 │
│ notify.ts       │ 通知     │                 │
│ sender.ts       │ 发卡     │                 │
│ card-dsl.ts     │ 卡片 DSL │                 │
└─────────────────┘          └─────────────────┘
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
├── src/
│   ├── index.ts         # 入口，轮询循环
│   ├── config.ts        # 加载 feishu.json，配置常量
│   ├── db.ts            # SQLite 查询封装
│   ├── state-machine.ts # 状态检测与转换
│   ├── notify.ts        # 卡片构建 + 发送
│   ├── sender.ts        # Feishu API（token + 发送）
│   ├── card-dsl.ts      # DSL → Card 2.0 JSON（port from plugin src/tools/send-card.ts）
│   └── utils.ts         # TtlMap
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

## 依赖的插件文件

| 文件 | 来源 | 用途 |
|---|---|---|
| `~/.config/opencode/plugins/feishu.json` | opencode-feishu 插件 | appId / appSecret |
| `~/.local/share/opencode/opencode.db` | OpenCode | session / part 表查询 |

## 与原插件的关系

| | opencode-feishu 插件 | passive 模式 |
|---|---|---|
| 触发方式 | 飞书消息→AI→飞书 | DB 轮询 |
| AI 算力 | 消耗 | 不消耗 |
| 状态检测 | WebSocket 事件 | part 表轮询 |
| 发卡片能力 | feishu_send_card tool | Feishu API 直接调 |
| 可独立运行 | 否（依赖 opencode） | 是 |