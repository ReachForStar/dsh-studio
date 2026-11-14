---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-approval-full-access

English | [中文](2026-11-14-approval-full-access.zh.md)

## Summary

Adds the log-only approval/full-access receipt recording an explicit full-access grant from a pending approval prompt.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-approval-full-access
baseline: false
changes:
  - root: "event:approval/full-access"
    previous: null
    after: "8226c9a496472402b300e86c9d3bd7b7eefc3f327747c7e8fa7cb3002ad4ef9f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The event is a required member of the Session vocabulary with no ignorable marker. An older reader that does not know it refuses the log instead of reconstructing a session with the grant missing, so omission is never interpreted as no grant. Newer readers validate the receipt payload and never turn it into an approval rule: the grant does not auto-allow any later request. Existing records and events are unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/interaction/user-approval/tests packages/interaction/permission-presets/tests packages/client/ui-approval/tests: 174 tests passed; pnpm run typecheck; pnpm run test:docs; pnpm run verify-persistence-catalog; pnpm run verify-type-equiv.

<a id="dev-note"></a>
## Dev Note

None.
