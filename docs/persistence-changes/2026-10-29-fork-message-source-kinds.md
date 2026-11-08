---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-29-fork-message-source-kinds

English | [中文](2026-10-29-fork-message-source-kinds.zh.md)

## Summary

Carries the fork's own message source kinds (`ui-polish`, `a2a-seat`) and the peer-message source union forward over the upstream records merged on 2026-10-29, so the acknowledged shape of `event:user/message`, `event:developer/message`, `event:agent/inbox/spliced`, `event:session/title-llm-request` and `event:assistant/peer-message` equals what this checkout's writer produces. The writer stays at Session format v5.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-29-fork-message-source-kinds
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "184925c3b6e98f38ae19149784d74278636daa5bc92b88a46cad1bf0916ffcab"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-10-27-fork-peer-source-kind"
    after: "9af9dbed6ece232715cf6c55950f56b0e261b0750a4844f6efe159e32827064a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "70197ed95a7191e06c3831d0d4c7a310bb80fa7fb303e8197e72e9e0732cfce1"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "b606a2a3289e157bb7dac50d58ce007fa636152236822cc00054a918da53f03c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "30a2184838c050b44a86b02133e8568dbeefc9935ca3b07ee1e49c052a495758"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both directions stay safe without a version bump. A reader that never mounts the fork's producers meets these kinds the way it meets any source kind its own tree does not produce: it keeps the message and its JSON metadata and derives the text as ordinary context, which is the behavior each of these roots already specifies for unknown source kinds. A reader of records written before this acknowledgement keeps every existing field, discriminator and required property unchanged — the fork kinds only add alternatives to the merge-extensible `MessageSourceMap` union that `assistant/peer-message.data.message.source` and `session/title-llm-request.data.messages[]` carry, and no older record can contain those values, so how older records are interpreted cannot change. No new discriminator is needed: `kind` still selects every source variant, so unsafe interpretation is already impossible.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-catalog: catalog and machine inventory current. pnpm run verify-persistence-formats: v0 through v5 verified (6 complete references). pnpm run verify-persistence-releases: records and adjacent transitions verified. pnpm run typecheck: 5 gates passed. pnpm exec vitest run packages/session/session-format-v4-to-v5 packages/session/session-format-catalog packages/session/message-quotes: migration, catalog and source-union suites passed.

<a id="dev-note"></a>
## Dev Note

None.
