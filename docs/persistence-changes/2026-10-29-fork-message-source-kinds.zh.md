---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-29-fork-message-source-kinds

[English](2026-10-29-fork-message-source-kinds.md) | 中文

## 概述

把 fork 自有的消息来源种类（`ui-polish`、`a2a-seat`）与 peer 消息来源联合延续到 2026-10-29 并入的上游记录之后，使 `event:user/message`、`event:developer/message`、`event:agent/inbox/spliced`、`event:session/title-llm-request`、`event:assistant/peer-message` 的已确认形态与本检出写入器实际产出的形态一致。写入器仍为会话格式 v5。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-29-fork-message-source-kinds
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "ee3c104a20873b51c9c2fa1fe67285fc86e264b47e34cee7dd6719f809c3c909"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-10-27-fork-peer-source-kind"
    after: "9561cacc5db3d4170ff6f8e37412284ab0b8390e35f42da001513f6c71239870"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "7c90829567ad8f57b95426424f5bef9aaf2a4e95f60cdbc01755836cd11c7839"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "1f6a3b382252ced9342be7cfd67f99a51820e1f5be7380a19c8171e2bc3a1435"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "a91046a4ffac9310337b951cb8ddc701a27d8053a3699e7e1b25ec2cff952ee2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个读取方向都不需要提升版本。未挂载 fork 生产者的读者遇到这些种类，与遇到任何自己树中不生产的来源种类相同：保留消息及其 JSON 元数据，把文本当普通上下文派生，这正是这些根对未知来源种类已有的行为。读本确认之前记录的读者，全部既有字段、判别属性与必填属性都不变——fork 种类只是向 `assistant/peer-message.data.message.source` 与 `session/title-llm-request.data.messages[]` 承载的可合并扩展联合 `MessageSourceMap` 追加分支，而更早的记录不可能含这些取值，因此旧记录的解读方式不会改变。无需新增判别属性：`kind` 仍能选出每个来源分支，不安全解读本已被阻止。

<a id="verification"></a>
## 验证

pnpm run verify-persistence-catalog：生成目录与机器记录均为最新。pnpm run verify-persistence-formats：v0 至 v5 校验通过（6 份完整参考）。pnpm run verify-persistence-releases：记录与相邻迁移校验通过。pnpm run typecheck：5 门通过。pnpm exec vitest run packages/session/session-format-v4-to-v5 packages/session/session-format-catalog packages/session/message-quotes：迁移、目录与来源联合套件通过。

<a id="dev-note"></a>
## 开发备注

无。
