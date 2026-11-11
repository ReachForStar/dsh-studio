---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-fork-paper-source-and-title-usage

English | [中文](2026-11-11-fork-paper-source-and-title-usage.zh.md)

## Summary

Adds the paper-reader message source kind to persisted message roots and records auxiliary session-title model usage in a new session/title-llm-usage event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-fork-paper-source-and-title-usage
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-29-fork-message-source-kinds"
    after: "e697d140169618a9800d192f1e122d21cd9a9c61c60c597ce1e5c16e992896fb"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-10-29-fork-message-source-kinds"
    after: "69484a97339c2400270e969c14e2f53be320095f6069dc3d7c5f30eeefae9280"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-29-fork-message-source-kinds"
    after: "07cf056b9440f2b5f093505ca2ba09eaa07b46df857b9b2797f528b6c55b83b0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-29-fork-message-source-kinds"
    after: "d1ea6d45ab147b0590c4b86148a7c65da9d7c98ebcd285b6fd7ae4ea5a2c037c"
    decision: same-version
  - root: "event:session/title-llm-usage"
    previous: null
    after: "81d7af3fe0e21b73d273691baa64486e440cf51a6e1c22a5b10785c55d52208b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-29-fork-message-source-kinds"
    after: "222f50086ffb23599166cc35d05a980d59272390439e03f8cb99c0bf8254393a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The new source kind is additive and marked @persistenceAttribution: readers preserve those messages and their JSON metadata without the producing plugin. The assistant/peer-message and session/title-llm-request source unions gain the same kind; peer messages stay readable as ordinary non-model sources, and title request messages are log-only inputs that no conversation surface interprets. A reader that predates session/title-llm-usage treats it as an unknown required event and refuses the Session before execution instead of reconstructing a token total that omits billed usage; readers that know it add the recorded usage to tokenUsage. Existing records remain valid and keep their totals.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes after this record; pnpm exec vitest run packages/session/session-title-llm/tests/llm.spec.ts packages/llm/token-meter/tests/token-usage-projection.spec.ts exercises the usage record and its tokenUsage fold.

<a id="dev-note"></a>
## Dev Note

None.
