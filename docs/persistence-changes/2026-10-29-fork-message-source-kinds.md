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
## Compatibility

Both directions stay safe without a version bump. A reader that never mounts the fork's producers meets these kinds the way it meets any source kind its own tree does not produce: it keeps the message and its JSON metadata and derives the text as ordinary context, which is the behavior each of these roots already specifies for unknown source kinds. A reader of records written before this acknowledgement keeps every existing field, discriminator and required property unchanged — the fork kinds only add alternatives to the merge-extensible `MessageSourceMap` union that `assistant/peer-message.data.message.source` and `session/title-llm-request.data.messages[]` carry, and no older record can contain those values, so how older records are interpreted cannot change. No new discriminator is needed: `kind` still selects every source variant, so unsafe interpretation is already impossible.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-catalog: catalog and machine inventory current. pnpm run verify-persistence-formats: v0 through v5 verified (6 complete references). pnpm run verify-persistence-releases: records and adjacent transitions verified. pnpm run typecheck: 5 gates passed. pnpm exec vitest run packages/session/session-format-v4-to-v5 packages/session/session-format-catalog packages/session/message-quotes: migration, catalog and source-union suites passed.

<a id="dev-note"></a>
## Dev Note

None.
