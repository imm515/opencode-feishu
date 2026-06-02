# opencode-feishu Passive Monitor 开发记录

## 架构演变

### v1 — 状态机 (edge-triggered)
- 使用 `detectSessionState` / `detectTransition` 检测 working→waiting→done
- 需要跟踪每个 session 的 prev state，跨重启容易出 bug
- **已废弃**

### v2 — DB-change-driven (result-push)
- `getLatestPartTime(sessionId)` 返回 `MAX(part.time_created)` — 检测任何新 part
- `getLatestAssistantPart(sessionId)` 提取 AI 回复文本
- 推判定：`latestPartTime > lastSeenTime` 则推
- 首次启动 prime 所有 session，不推

## 关键技术决策

### 1. node:sqlite vs sql.js + WAL
- OpenCode DB 使用 SQLite **WAL 模式**
- `sql.js`（WebAssembly 版）只读主文件，**无法读取 WAL 内容**
- 解决方案 1：`sql.js` + `PRAGMA wal_checkpoint(TRUNCATE)` 前置 — 有 PATH 和 race 问题
- 解决方案 2：`node:sqlite`（Node 22+ 内置）— 原生支持 WAL ✅ **当前方案**

### 2. 线程颜色
- 参考 SunCodexClaw watcher 的 `getThreadStyle`
- 按 sessionId 哈希取模分配 6 种飞书卡片模板色
- 保证同一 session 始终同一颜色

### 3. @all
- done 卡片末尾加 `<at id=all></at>`

### 4. 时区
- 日志全用 `Asia/Shanghai`（UTC+8）
- 卡片时间显示为 `YYYY-MM-DD HH:mm:ss`

### 5. "完成"检测
- **无法从 SQLite 准确感知对话完成**
- OpenCode plugin 能做到是因为它有 hook/事件回调
- SQLite 里没有 `task_complete` 事件，只有 tool/reasoning/text part
- 社区工具 `ocmonitor`（Python, 321 stars）同样用 SQLite，通过 **30 分钟超时** 判断 session 是否活跃
- 当前方案：只推 reply，不感知 done

## 社区参考

### opencode-monitor (actualyze-ai)
- 5 stars, TypeScript
- 需要安装 OpenCode plugin（WebSocket 通信）
- 支持桌面通知、多机监控
- 本质是插件+WebSocket，不是纯 DB 轮询

### ocmonitor (Shlomob)
- 321 stars, Python
- 纯 SQLite 读取，无插件依赖
- 使用 `message.time_created > threshold` 判断活跃度
- 支持完整的用量统计、项目分析、模型分析
- 超时阈值为 30 分钟

## 启动配置
- daemon 用 `Start-Process node.exe dist/index.js` 后台运行
- PID 文件写入 `.passive.pid`
- Task Scheduler 任务：`OpenCodeFeishuPassive`（存在但未验证正常触发）

## 日志
- 按日分文件 `YYYY-MM-DD.log`
- 7 天自动清理
- 5MB 大小旋转
