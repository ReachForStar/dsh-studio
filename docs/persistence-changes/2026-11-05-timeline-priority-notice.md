---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-timeline-priority-notice

English | [中文](2026-11-05-timeline-priority-notice.zh.md)

## Summary

Records a Timeline notice when the user adds or removes urgent priority.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing messages keep their source and meaning. Timeline notices carry ordinary text and a source label. Readers without Timeline can keep the unknown source and read the text without applying a task update. Timeline stores task trees, reports, and discussions in the session log as ignorable `plugin:timeline/*` records. Readers without Timeline skip these records.

<a id="verification"></a>
## Verification

Timeline's priority tests check that only user edits to urgent priority enqueue a notice. The process recovery test checks that Timeline state survives an interrupted writer.

<a id="dev-note"></a>
## Dev Note

None.
