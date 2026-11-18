---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-virtual-model-state

English | [中文](2026-11-18-virtual-model-state.zh.md)

## Summary

Adds the log-only virtual-model/state event and the host-only virtualModelState projection.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-virtual-model-state
baseline: false
changes:
  - root: "event:virtual-model/state"
    previous: null
    after: "7eaa920533f0adf7f98248229a615974079f852ade6b8d125ae7d4745e8a8b85"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Older readers skip virtual-model/state as an unknown ignorable event, so surface reconstruction and derived history are unchanged; the projection is host-only and no client view reads it. Newer readers reading older logs see no router state, which is the empty state. No discriminator is reinterpreted.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/agent-virtual-model: 5 tests passed; the projection folds the latest state per virtual model and resolve persists a returned state.

<a id="dev-note"></a>
## Dev Note

None.
