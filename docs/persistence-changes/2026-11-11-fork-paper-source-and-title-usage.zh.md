---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-11-fork-paper-source-and-title-usage

[English](2026-11-11-fork-paper-source-and-title-usage.md) | 中文

## 概述

为持久化消息根新增 paper-reader 来源种类，并用新的 session/title-llm-usage 事件记录会话标题的辅助模型用量。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-fork-paper-source-and-title-usage
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-29-fork-message-source-kinds"
    after: "e697d140169618a9800d192f1e122d21cd9a9c61c60c597ce1e5c16e992896fb"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-10-29-fork-message-source-kinds"
    after: "69484a97339c2400270e969c14e2f53be320095f6069dc3d7c5f30eeefae9280"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-29-fork-message-source-kinds"
    after: "07cf056b9440f2b5f093505ca2ba09eaa07b46df857b9b2797f528b6c55b83b0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-29-fork-message-source-kinds"
    after: "d1ea6d45ab147b0590c4b86148a7c65da9d7c98ebcd285b6fd7ae4ea5a2c037c"
    decision: same-version
  - root: "event:session/title-llm-usage"
    previous: null
    after: "81d7af3fe0e21b73d273691baa64486e440cf51a6e1c22a5b10785c55d52208b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-29-fork-message-source-kinds"
    after: "222f50086ffb23599166cc35d05a980d59272390439e03f8cb99c0bf8254393a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新来源种类是加法变更并带 @persistenceAttribution：未安装生产方的读取器会保留这些消息及其 JSON 元数据。assistant/peer-message 与 session/title-llm-request 的来源联合同样增加该种类；对等消息仍可用作普通非模型来源，标题请求消息只是日志输入，任何对话界面都不解释它。早于 session/title-llm-usage 的读取器把它当作未知必需事件，在执行前拒绝该会话，而不是重建一个漏记账单的 token 合计；认识该事件的读取器把记录的用量加入 tokenUsage。已有记录仍然有效，合计保持不变。

<a id="verification"></a>
## 验证

本记录后运行 pnpm run verify-persistence-changes；pnpm exec vitest run packages/session/session-title-llm/tests/llm.spec.ts packages/llm/token-meter/tests/token-usage-projection.spec.ts 覆盖用量记录及其 tokenUsage 折叠。

<a id="dev-note"></a>
## 开发备注

无。
