---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-action-card-status

English | [中文](2026-10-22-action-card-status.zh.md)

## Summary

Adds action-card status attribution to logged model context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing messages and records are unchanged. Readers without the action-card plugin preserve the new action-cards source kind and its JSON metadata and derive the recorded text as ordinary context. Only the producer uses the through sequence, to acknowledge delivered decisions; it grants no authority and does not change replay interpretation.

<a id="verification"></a>
## Verification

pnpm exec vitest run on the action-cards, creation-recommendations, client-ui-action-cards and client-ui-creation-recommendations tests: 120 tests passed with 100% coverage of their sources. The Web creation-recommendations replay logs the status notice of a dismissed card before the next answer.

<a id="dev-note"></a>
## Dev Note

None.
