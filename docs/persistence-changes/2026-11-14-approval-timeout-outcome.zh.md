---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-approval-timeout-outcome

[English](2026-11-14-approval-timeout-outcome.md) | 中文

## 概述

新增 timed-out 审批结果，并确认当前树中既有的 fork 来源种类与用量联合。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-approval-timeout-outcome
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-10-03-session-format-v5"
    after: "fa9421a1f7983f794edf29402dd3fc00da2cd21c18fa4138e361e0f36330d06f"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-12-arena"
    after: "12767817f198a232255902a126e6cc6833c591bc396d76cf678235dd728d7465"
    decision: same-version
  - root: "event:approval/decided"
    previous: "2026-09-11-initial"
    after: "c5028106a70826fc22717f5f83930bd6421fda0302e5bb8b61d258e3148c8890"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-11-12-arena"
    after: "30b69c7a12de9a5c37bb7e78bad212190340ff490c870ba51d95819b8f8ecaf1"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-12-arena"
    after: "cb1e995deb353263854520e3985132e6f0bd5c3e5a3042e6875afcbc1fbeb660"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-12-arena"
    after: "89b32a13e8393f70982cd4bf20a2a4cc21ee0314966eb15ec7f1cde82b02637c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-12-arena"
    after: "16b582a8738d389ef681eb9491df1beaa1a5f6435a57bb2552b532ccbac3425e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

approval/decided.data.outcome 新增 timed-out；不认识该取值的读取器会保留审计事件并把决定视为未放行，操作仍然失败关闭。既有结果取值含义不变。其余消息来源种类只由本 fork 生产；没有对应生产者的读取器会把该消息保留为普通输入，读取旧日志的读取器则看不到这些种类。没有判别属性被重新解释，因此 SessionHeader.version 仍为 5。

<a id="verification"></a>
## 验证

本记录后 pnpm run verify-persistence-changes 的每个根均匹配。pnpm exec vitest run packages/interaction/user-approval/tests 覆盖超时审计对；pnpm run typecheck 通过。

<a id="dev-note"></a>
## 开发备注

无。
