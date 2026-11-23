---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-23-retain-removed-fork-events

[English](2026-11-23-retain-removed-fork-events.md) | 中文

## 概述

回退 qwen-code、pi、opencode 与 codex 来源的能力后，保留七个 log-only 事件与九种消息来源声明的持久化记录；`approval/decided.outcome` 回到上游的取值集合。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-23-retain-removed-fork-events
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-11-14-approval-timeout-outcome"
    after: "304e47d57244dcff41c96e5e1dd31f21f818a799a7ff5354017944975e1bec54"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-19-cua-input-notices"
    after: "5c681e2be1021c062928224c7faf9a04f3b29d1a15fb4da86bfeba247fef2817"
    decision: same-version
  - root: "event:approval/decided"
    previous: "2026-11-14-approval-timeout-outcome"
    after: "bb1ab3d08f49a9f3b265f844cd78d5c49813062a7b34b54904b426f85d0ff6e3"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "697fc97857bcd95260c02033cea4130e94c5f1e7fb6822986d53a5ab373d37a2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "47d6fc3a9f479e2afd055a449421e31de4d5cdfee12ad2926cd125986fc6e46b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "3224dd1dfc015cbc730f9e1fe94bf833a66f4d9fa989dad530e3ceb02246dd42"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "5b2a52e7062e3934321fec05d3663769bcec9be77c455b9a7e9fa33ee9fbcc99"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

会话格式 V5 不变：没有判别字段、头、角色或既有来源含义的改动，0.2.2-rc.3、0.2.2-rc.4 与 0.2.3-alpha.2 发布过的类型全部仍被识别。保留的成员位于 `packages/core/session/src/retained-events.ts` 与 `packages/interaction/user-approval/src/retained-events.ts`；本构建没有这些记录的生产者，也没有投影折叠它们，因此这些记录保留文本与元数据，不影响重建的历史。`approval/decided.outcome` 不再出现 `timed-out`：该值由已移除的审批超时产生，读取方会把上游集合之外的值当作未知结果而非结论。

<a id="verification"></a>
## 验证

`pnpm run verify-persistence-changes` 与 `pnpm run verify-persistence-catalog` 通过。`pnpm run test` 覆盖 `packages/core/session`、`packages/mcp/mcp-client`、`packages/mcp/mcp-resources` 与 `packages/experimental/webhook`：49 个文件、1065 个测试全部通过。`pnpm run doc-typecheck` 编译 120 个代码块。

<a id="dev-note"></a>
## 开发备注

无。
