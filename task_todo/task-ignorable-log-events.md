# 修复：fork 自研日志事件锁死旧版读取（session/title-llm-usage）

## 现象与根因

旧版 harness 打开新版 fork 写的会话时报 `contains event type "session/title-llm-usage" (seq 18) unknown to this harness and not marked ignorable`。当前源码可正常读取该文件（已实测 30 事件、v5），说明写侧把 fork 自研的**仅日志**事件当成了必读事件，跨版本必然拒绝。

## 里程碑

- [x] 里程碑：`Session` 新增「仅日志事件可标记 ignorable」的写入口（类型层禁止 surface 事件使用）
  - `LogOnlyEventOptions` + `SessionEventInput` 第三元素 + `snapshotAppend` 写入信封；消息类事件运行时抛错。
- [x] 里程碑：`session-title-llm` 的两条事件改用该入口，旧版可跳过
  - 两条记录均带 `ignorable: true`，用例断言标记存在。
- [x] 里程碑：文档与 Agent Note 记录该兼容机制，生成物重跑
  - 新增 Agent Note（中英）+ 修正 2026-08-30 决策表述；session 与 title-llm 中英 README 更新；type-equiv 块、持久化目录、cordis 目录重生成。
- [x] 里程碑：`typecheck`/`lint`/`build:check`/`test:docs` 与受影响 + 全量测试通过
  - 受影响 1842 通过 / 1 跳过；全量 60695 通过 / 1 既定期望失败 / 274 跳过；lint 0 error。
- [x] 里程碑：wiki 记录该故障与兼容机制，index/log 同步，提交推送
  - 新增 `queries/session-unknown-event-across-builds.md`。
- [x] 里程碑：本轮 `tmp/` 清理
