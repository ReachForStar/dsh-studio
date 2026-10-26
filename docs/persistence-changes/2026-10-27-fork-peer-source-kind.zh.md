---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-fork-peer-source-kind

[English](2026-10-27-fork-peer-source-kind.md) | 中文

## 概述

补记合并上游时遗留的一处根转换：`action-cards` 消息来源进入 `assistant/peer-message` 的来源联合。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-fork-peer-source-kind
baseline: false
changes:
  - root: "event:assistant/peer-message"
    previous: "2026-10-03-session-format-v5"
    after: "fea39317a952ff3e471f21b526dc20e31845e59743d6e73d3e238f3688a879c1"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该添加对读者是追加式的，因此这个根留在当前会话格式版本。`assistant/peer-message.source` 承载的是可合并扩展的消息来源联合，而不是可走同种豁免的 user/developer 归属绑定，因此未挂载 `action-cards` 生产者的读者原样保留该条消息及其 JSON 元数据，把通知文本当作普通上下文派生——这正是它对每个未生产来源种类的既有行为。新成员只追加了一个既有记录都不会携带的值，不会改变该根既有记录的解读方式。

<a id="verification"></a>
## 验证

`pnpm run verify-persistence-changes`：确认该转换后 67 个根与历史记录匹配。`pnpm exec vitest run packages/experimental/action-cards/tests`：4 个文件、28 项测试通过，覆盖产生新来源种类的生产者。`pnpm run verify-persistence-formats`：v0 至 v5 校验通过。

<a id="dev-note"></a>
## 开发备注

无。
