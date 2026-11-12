---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-11-tool-summary

[English](2026-11-11-tool-summary.md) | 中文

## 概述

新增仅记日志的 tool/batch-summary 事件，以及辅助工具 tool-summary 与 memory-notes 两种消息来源种类。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-tool-summary
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-11-fork-paper-source-and-title-usage"
    after: "d55397b2d90dd037bf2153ea335b9eb41953b27ffbae95a0961f1ce3e2c3c595"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-11-11-fork-paper-source-and-title-usage"
    after: "468489db1b1d2b6ab2dddc3f7204efa03ba727443f2868228ef2414b776b0072"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-11-fork-paper-source-and-title-usage"
    after: "d69caa9f9b1359baa0ab24cd0aad7c189f444fa79de2d16753901b9f110d8d10"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-11-fork-paper-source-and-title-usage"
    after: "e7ec2e8efc85d2cb9e0fcff01129bd8ff0b5ab35933808d677d9bf11536e0c49"
    decision: same-version
  - root: "event:tool/batch-summary"
    previous: null
    after: "6b4116398682a3a478e2ca219f7b263a5ed7cc9fc15f920f6306a2a872335a0c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-11-fork-paper-source-and-title-usage"
    after: "898c962c220f0ea2927eced7c7c1e92f353f1869d046320845e7f2f52ceb2f5e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧读取方：新事件仅记日志且不携带可见操作，surface 重建会将其作为未知可忽略事件跳过，派生出的模型历史完全相同；摘要不会进入任何请求。新增来源种类属于辅助请求与注入上下文；读取时消息内容原样保留，唯一按该种类分派的消费方就是产出它的包。新读取方读旧日志时看不到摘要事件，所有旧来源种类语义保持不变。两个改动都引入新键，不存在判别符重新解释的可能。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/tool-summary：17 个测试通过；逐文件覆盖率语句、分支、函数、行均为 100%。

<a id="dev-note"></a>
## 开发备注

无。
