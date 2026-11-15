---
title: 旧版 harness 拒读新版 fork 会话（session/title-llm-usage）
type: query
tags: [session-format, ignorable, 兼容性, session-title, 缺陷修复]
created: 2026-11-15
updated: 2026-11-15
sources: []
status: active
---

# 旧版 harness 拒读新版 fork 会话（session/title-llm-usage）

## 问题

打开一个会话时报：

```text
failed to observe session "…": session "…" contains event type "session/title-llm-usage" (seq 18)
unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely
written by a newer harness (raw log: ~/.dsh/sessions/…/session.v5.jsonl.zstd)（gateway/internal）
```

## 根因

`session/title-llm-request` 与 `session/title-llm-usage` 是 fork 的 `session-title-llm` 包声明的 `SessionEventMap` 成员，属于「仅日志」的用量记账。声明的成员默认必读（`KNOWN_SESSION_EVENT_TYPES` 是**构建级**清单）：某个构建如果没有声明这两个类型，`validateStoredEvents` 就会拒绝整份日志。写入方当时没有给这两条记录加 `ignorable`，于是任何早于该声明的构建都读不了新版 fork 写的会话——这正是报错文本所说的「由更新的 harness 写入」。

同一份日志用当前源码读取是正常的（实测 30 个事件、v5 头），所以问题不在日志损坏，而在读取方的词汇表。

## 解法

1. **写入方补可跳过标记**：`Session.append()` 新增 `LogOnlyEventOptions`（`{ ignorable?: true }`），只允许用于 `SurfaceEventType` 之外的事件；`SessionEventInput` 的第三个位置元素对同类事件承载它。`snapshotAppend` 把标记写进信封，并对消息类（surface）事件抛错——模型可见历史不允许被静默丢弃。运行时守卫与类型层重载共同保证这一点。
2. **`session-title-llm` 两条记录改为 `{ ignorable: true }`**：知道这些类型的构建照常读取（用量统计不受影响），没有声明的构建保留并跳过记录，继续打开会话。
3. **决策与文档**：新增 Agent Note [ignorable log-only events](../../../.agents/notes/implemented/architecture/2026-11-15-ignorable-declared-log-only-events.md)，并修正 2026-08-30 决策中「唯一第一方写入者」的表述；`packages/core/session` 与 `session-title-llm` 中英 README 同步；`session` 子系统文档的 type-equiv 块与持久化目录重生成。

不改 `KNOWN_SESSION_EVENT_TYPES`，不升 `SESSION_FORMAT_VERSION`：`ignorable` 是既有信封字段，当前与相邻代读取器都已接受。

## 验证

```bash
pnpm exec vitest run packages/core/session packages/session/session-title-llm \
  packages/session/session-persistence-jsonl packages/session/session-persistence packages/session/session-format-v4-to-v5   # 1842 通过 / 1 跳过
pnpm exec vitest run        # 全量 60695 通过 / 1 既定期望失败 / 274 跳过
pnpm run lint               # 0 error
pnpm run build:check
pnpm run test:docs          # 21 门（含 type-equiv 与双语配对）
```

新增用例：核心会话「仅在仅日志事件上写 ignorable，消息事件拒绝该标记」、标题包「两条辅助记录都带 ignorable」。

## 已存在的旧日志怎么办

已经被旧构建写出的日志里这两个事件**没有**标记，因此旧构建仍然拒绝——写入侧修复只对之后写出的日志生效。读取这类历史日志要用**声明了该词汇的构建**（当前源码、`0.2.2-rc.4` 及之后的安装包）。复现验证：用当前 JSONL 持久化打开该文件可正常读到 30 个事件。

## 复发预防

- 已发布包新增「仅日志」事件时必须写 `{ ignorable: true }`；携带状态或进入模型可见表面的事件保持必读，不得照搬。
- 评审新增 `SessionEventMap` 成员时先问「另一份词汇的构建读到它会不会拒绝」；能安全省略的就必须带标记。
- 遇到 `unknown … not marked ignorable` 时，先比对新旧构建的词汇表，再怀疑日志损坏。

## 涉及模块

- `packages/core/session`（`append` 选项、信封写入、`types.ts` 类型、README 与子系统文档）
- `packages/session/session-title-llm`（两条辅助事件与 README）
- 持久化拒绝路径：[`validateStoredEvents`](../../../packages/session/session-persistence/src/storage-contract.ts) 与构建级 [`KNOWN_SESSION_EVENT_TYPES`](../../../packages/core/session/src/known-event-types.ts)
- 决策：[ignorable log-only events](../../../.agents/notes/implemented/architecture/2026-11-15-ignorable-declared-log-only-events.md)、[保留可跳过事件](../../../.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md)
