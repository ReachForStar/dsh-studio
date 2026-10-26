---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-22-action-card-status

[English](2026-10-22-action-card-status.md) | 中文

## 概述

为写入日志的模型上下文新增操作卡片状态的来源标识。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-action-card-status
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-03-session-format-v5"
    after: "6986b223376590ba04aadcf574f0c8d5f5c367b0351a2d7c504e8bea62613898"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-03-session-format-v5"
    after: "42f1e731addff2053fa3902389ca005a1c9a3e261cb01dd6090fa10c1ce749a4"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-03-session-format-v5"
    after: "a187fae48d5d0fdbd6b96f69e16b3c77f1ad2f629e0951ba845176a364dba581"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-03-session-format-v5"
    after: "d46382bf1720628af3809dcac259883de2fd0ab985bddead0c6d7e5d206f1a4b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有消息和记录不变。没有操作卡片插件的读取方保留新的 action-cards 来源类型及其 JSON 元数据，并把记录的文本当作普通上下文。只有写入方使用 through 序号确认已送达的决定；它不授予任何权限，也不改变回放的解释。

<a id="verification"></a>
## 验证

对 action-cards、creation-recommendations、client-ui-action-cards 和 client-ui-creation-recommendations 的测试运行 pnpm exec vitest run：120 个测试通过，源码覆盖率 100%。Web creation-recommendations 回放在下一次回答之前记录了已忽略卡片的状态通知。

<a id="dev-note"></a>
## 开发备注

无。
