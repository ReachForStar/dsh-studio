---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-tool-summary

English | [中文](2026-11-11-tool-summary.zh.md)

## Summary

Adds the log-only tool/batch-summary event and the auxiliary tool-summary and memory-notes message source kinds.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-tool-summary
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-11-fork-paper-source-and-title-usage"
    after: "d55397b2d90dd037bf2153ea335b9eb41953b27ffbae95a0961f1ce3e2c3c595"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-11-11-fork-paper-source-and-title-usage"
    after: "468489db1b1d2b6ab2dddc3f7204efa03ba727443f2868228ef2414b776b0072"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-11-fork-paper-source-and-title-usage"
    after: "d69caa9f9b1359baa0ab24cd0aad7c189f444fa79de2d16753901b9f110d8d10"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-11-fork-paper-source-and-title-usage"
    after: "e7ec2e8efc85d2cb9e0fcff01129bd8ff0b5ab35933808d677d9bf11536e0c49"
    decision: same-version
  - root: "event:tool/batch-summary"
    previous: null
    after: "6b4116398682a3a478e2ca219f7b263a5ed7cc9fc15f920f6306a2a872335a0c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-11-fork-paper-source-and-title-usage"
    after: "898c962c220f0ea2927eced7c7c1e92f353f1869d046320845e7f2f52ceb2f5e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Older readers: the new event is log-only and carries no surface operation, so surface reconstruction skips it as an unknown ignorable event and derives identical model history; the summary never enters a request. The new source kinds belong to auxiliary requests and injected context. Reading them yields the message content unchanged; the only consumer that dispatches on this kind is the producing package. Newer readers reading older logs simply see no summary events, and every older source kind keeps its meaning. No discriminator reinterpretation is possible because both additions introduce new keys.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/tool-summary: 17 tests passed; per-file coverage 100% statements, branches, functions, and lines.

<a id="dev-note"></a>
## Dev Note

None.
