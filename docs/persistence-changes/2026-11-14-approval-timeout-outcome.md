---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-approval-timeout-outcome

English | [中文](2026-11-14-approval-timeout-outcome.zh.md)

## Summary

Adds the timed-out approval outcome and acknowledges the fork source kinds and usage union already present in the current tree.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

approval/decided.data.outcome gains timed-out; a reader that does not know it keeps the audit event and treats the decision as a non-grant, so the action still fails closed. Every earlier outcome keeps its meaning. The additional message source kinds are produced only by this fork; readers without the producer retain such a message as ordinary input, and readers of older logs see no such kind. No discriminator is reinterpreted, so SessionHeader.version stays 5.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes matches every root after this record. pnpm exec vitest run packages/interaction/user-approval/tests covers the timeout audit pair; pnpm run typecheck passes.

<a id="dev-note"></a>
## Dev Note

None.
