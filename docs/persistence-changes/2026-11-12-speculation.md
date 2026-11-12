---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-speculation

English | [中文](2026-11-12-speculation.zh.md)

## Summary

Adds the log-only speculation/proposal and speculation/outcome events and the auxiliary dsh-speculation message source kind.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-speculation
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-11-followup"
    after: "adfd43dadd32451530eaa2c743edc0f98d25f3b95f528d8ea944130f7623236d"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-11-11-followup"
    after: "0f0ce4b4bad8a1c29d5a4b53cfa981134ea99528c3f690109cfe288e04dee5da"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-11-followup"
    after: "943bce2d21ee482101ccf63e6ea070f7db1de9afa9070bafcc32dcc4fd96e938"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-11-followup"
    after: "66be1c5bef9975ff829148d7268b257ff61403ef9837f1529bb1a6f88eb8f285"
    decision: same-version
  - root: "event:speculation/outcome"
    previous: null
    after: "673ec3ae97815d7fa1121e4dfe707034c1f639fc2de849c98c137c8f25885bb7"
    decision: same-version
  - root: "event:speculation/proposal"
    previous: null
    after: "f141ed59285c1ed4b080d4bb84f45f8e0751617c9bb9c96ebebb487478c85930"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-11-followup"
    after: "cb5eade0b075d95de0eabb5917af39c194ed340b2c4e04dbd9a99d40c1d0ea44"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both new events are log-only and carry no surface operation, so an older reader reconstructs the same model history by skipping them as unknown ignorable events. The dsh-speculation source kind belongs to one-message auxiliary prediction requests that never enter the conversation surface; readers preserve the content unchanged and no consumer dispatches on the kind outside the producing package. Newer readers reading older logs see neither event and every prior source kind keeps its meaning, so no discriminator is reinterpreted.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/speculation: 55 tests passed across the gate, overlay, and runner suites; per-file coverage 100% statements, branches, functions, and lines.

<a id="dev-note"></a>
## Dev Note

None.
