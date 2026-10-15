---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-session-format-v5

[English](2026-10-03-session-format-v5.md) | 中文

## 概述

确认本分叉的 V4→V5 会话写入器转换，以及相对已接受 V4 基线的其余持久化差异：表头版本字面量、两个表头上的 `backend` 字段、`assistant/peer-message` surface 根、两个仅作归属标记的用户来源类型，以及 `xingchen/dispatch-progress` 事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-session-format-v5
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "304e47d57244dcff41c96e5e1dd31f21f818a799a7ff5354017944975e1bec54"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "4007cc8ddaceeecf565c03721c83036dfa1bd3e8e8e8873b446e152d005b6b13"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "8f8deedcaa228e1f8735f8c34ebeaa4f4d9ae10bb2ac3de899aabe202a364aa1"
    decision: version-bump
  - root: "event:assistant/peer-message"
    previous: null
    after: "836d3ad11feb3a2694d374cadaecf1eb110960d55a8e5b702c9886185567f396"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "c1e290c4d3c1ba835a93bf76e62398522299d901c02def708bb4b30eca2310cb"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "8d585cddb10057535c5e0a330b3aee41aac73a4ea3a4773e0f117e27fc2c1884"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "e0a90cfbfe3922bfe638df5359dd09197ef0932016cbbf9c5d22de7e3f1147ea"
    decision: version-bump
  - root: "event:xingchen/dispatch-progress"
    previous: null
    after: "9474bbb067c7b190f6aef17f0afaa7ca30daeaca1dc9539c040fc8e886fa3b01"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

V4 日志无需手工改写仍可读：相邻的 `session-format-v4-to-v5` 迁移在打开会话时升级它，更早的每一代也各有自己的相邻步骤，因此落盘日志按代际顺序依次转换。V5 日志需要认识 V5 的构建；旧读者会拒绝它，而不是对未知根做猜测，也不存在降级路径。`SessionHeader.backend` 与 `JsonlHeaderLine.backend` 都是可选字段，缺少它们的 V4 时期表头仍能加载，并按默认的 `dsh` 循环读取。`ui-polish` 与 `a2a-seat` 两个用户来源类型只作归属标记：没有对应生产者的读者会原样保留该消息及其 JSON 元数据，两个类型都不带校验、重放或授权要求。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session packages/core/session：145 个文件，3587 项测试通过（11 项跳过），覆盖相邻迁移链、V4→V5 编解码器与校验器以及当前写入器。pnpm run verify-persistence-formats：v0 到 v5 共六份完整参考校验通过。pnpm run verify-persistence-catalog：目录、schema 与 known-event-types 均为最新。

<a id="dev-note"></a>
## 开发备注

无。
