---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-approval-full-access

[English](2026-11-14-approval-full-access.md) | 中文

## 概述

新增仅日志的 approval/full-access 回执，记录从待审批提示做出的显式完全访问授权。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-approval-full-access
baseline: false
changes:
  - root: "event:approval/full-access"
    previous: null
    after: "8226c9a496472402b300e86c9d3bd7b7eefc3f327747c7e8fa7cb3002ad4ef9f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该事件是会话事件词汇中的必需成员，不带 ignorable 标记。不认识它的旧读取方会拒绝该日志，而不是重建一个缺少授权的会话，因此缺失绝不会被解释为未授权。新读取方校验回执载荷，且绝不把它变成审批规则：该授权不会自动放行之后的任何请求。既有记录与事件保持不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/interaction/user-approval/tests packages/interaction/permission-presets/tests packages/client/ui-approval/tests：174 个测试通过；pnpm run typecheck；pnpm run test:docs；pnpm run verify-persistence-catalog；pnpm run verify-type-equiv。

<a id="dev-note"></a>
## 开发备注

无。
