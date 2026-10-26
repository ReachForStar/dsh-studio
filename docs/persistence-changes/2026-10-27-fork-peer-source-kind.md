---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-fork-peer-source-kind

English | [中文](2026-10-27-fork-peer-source-kind.zh.md)

## Summary

Records the one root transition the upstream merge left unacknowledged: the `action-cards` message source entering the `assistant/peer-message` source union.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-fork-peer-source-kind
baseline: false
changes:
  - root: "event:assistant/peer-message"
    previous: "2026-10-03-session-format-v5"
    after: "fea39317a952ff3e471f21b526dc20e31845e59743d6e73d3e238f3688a879c1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The addition is additive for readers, so this root stays on the current Session format version. `assistant/peer-message.source` carries the merge-extensible message-source union, not the user/developer attribution binding that would allow the same-kind shortcut, so a reader that does not mount the `action-cards` producer preserves the recorded message and its JSON metadata unchanged and derives the notice text as ordinary context — the behavior it already applies to every source kind it does not produce. The new member therefore adds a value no existing record carries and cannot change how an existing record of this root is read.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes: 67 roots match the history records with this transition acknowledged. pnpm exec vitest run packages/experimental/action-cards/tests: 4 files, 28 tests passed, covering the producer that emits the new source kind. pnpm run verify-persistence-formats: v0 through v5 verified.

<a id="dev-note"></a>
## Dev Note

None.
