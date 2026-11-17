---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-timeline-priority-notice

[English](2026-11-05-timeline-priority-notice.md) | 中文

## 概述

记录用户添加或取消紧急优先级时的时间线通知。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-timeline-priority-notice
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-14-approval-timeout-outcome"
    after: "970e47c097fb18a29281e43a62d9c82c90756c0a6216c86f4a44f49f60c74162"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-11-14-approval-timeout-outcome"
    after: "eeaf6a9cb762990d0f11bbe6b219546a8fc1fd30147d71f38ac16443a39901cc"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-14-approval-timeout-outcome"
    after: "c1c8bc2eb3d12acd176c3ccb22c8357b52b44812db80809d580071dd4c519190"
    decision: same-version
  - root: "event:session/label"
    previous: null
    after: "f7f44448859d5a91808b3824560a7084e29f93217fc5c547900f71765db3f0bd"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-14-approval-timeout-outcome"
    after: "93f15cbe8eb42458b9018da66d0f0178db6daf6fdf8641349a70ba1ee79fba61"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-14-approval-timeout-outcome"
    after: "fdca9c87136aa76b33f0a0246f5dd7c827fcf53ae8f1a423d2e470c2aed095ac"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有消息保留原有来源和含义。时间线通知包含普通文本和来源标签。未加载时间线的读取方可保留未知来源并读取文本，无需应用任务更新。时间线将任务树、报告和讨论保存为会话日志中可忽略的 `plugin:timeline/*` 记录。未加载时间线的读取方会跳过这些记录。

<a id="verification"></a>
## 验证

时间线优先级测试验证仅用户修改紧急优先级时才排入通知。进程恢复测试验证写入进程意外退出后仍可恢复时间线状态。

<a id="dev-note"></a>
## 开发备注

无。
