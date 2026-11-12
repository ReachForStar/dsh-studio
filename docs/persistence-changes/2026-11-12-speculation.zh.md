---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-speculation

[English](2026-11-12-speculation.md) | 中文

## 概述

新增仅日志的 speculation/proposal 与 speculation/outcome 事件，以及辅助请求使用的 dsh-speculation 消息来源种类。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-speculation
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-11-followup"
    after: "adfd43dadd32451530eaa2c743edc0f98d25f3b95f528d8ea944130f7623236d"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-11-11-followup"
    after: "0f0ce4b4bad8a1c29d5a4b53cfa981134ea99528c3f690109cfe288e04dee5da"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-11-followup"
    after: "943bce2d21ee482101ccf63e6ea070f7db1de9afa9070bafcc32dcc4fd96e938"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-11-followup"
    after: "66be1c5bef9975ff829148d7268b257ff61403ef9837f1529bb1a6f88eb8f285"
    decision: same-version
  - root: "event:speculation/outcome"
    previous: null
    after: "673ec3ae97815d7fa1121e4dfe707034c1f639fc2de849c98c137c8f25885bb7"
    decision: same-version
  - root: "event:speculation/proposal"
    previous: null
    after: "f141ed59285c1ed4b080d4bb84f45f8e0751617c9bb9c96ebebb487478c85930"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-11-followup"
    after: "cb5eade0b075d95de0eabb5917af39c194ed340b2c4e04dbd9a99d40c1d0ea44"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个新事件都是仅日志事件、不带任何 surface 操作，旧读取器会按未知可忽略事件跳过，从而重建出相同的模型历史。dsh-speculation 来源种类只用于单条辅助预测请求，内容从不进入会话面；读取器原样保留内容，生成包之外没有消费者按该种类分支。新读取器读旧日志时看不到这两个事件，既有来源种类的含义不变，因此没有判别式被重新解释。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/speculation：门控、overlay、runner 三个测试文件共 55 个用例通过；逐文件覆盖率 100%（语句、分支、函数、行）。

<a id="dev-note"></a>
## 开发备注

无。
