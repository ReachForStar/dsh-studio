---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-virtual-model-state

[English](2026-11-18-virtual-model-state.md) | 中文

## 概述

新增仅日志的 virtual-model/state 事件与仅宿主的 virtualModelState 投影。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-virtual-model-state
baseline: false
changes:
  - root: "event:virtual-model/state"
    previous: null
    after: "7eaa920533f0adf7f98248229a615974079f852ade6b8d125ae7d4745e8a8b85"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧读取器把 virtual-model/state 当作未知可忽略事件跳过，表面重建与派生历史不变；投影仅宿主，无客户端视图读取。新读取器读取旧日志看不到路由状态，即空状态。不重新解释任何判别式。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/agent-virtual-model：5 项测试通过；投影按虚拟模型折叠最新状态，resolve 持久化返回的状态。

<a id="dev-note"></a>
## 开发备注

无。
