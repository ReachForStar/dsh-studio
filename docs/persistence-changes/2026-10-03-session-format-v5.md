---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-session-format-v5

English | [中文](2026-10-03-session-format-v5.zh.md)

## Summary

Acknowledges this fork's V4-to-V5 Session-writer transition and every remaining persisted difference from the accepted V4 baseline: the header version literal, the `backend` field on both headers, the `assistant/peer-message` surface root, two attribution-only user-source kinds, and the `xingchen/dispatch-progress` event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-session-format-v5
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "304e47d57244dcff41c96e5e1dd31f21f818a799a7ff5354017944975e1bec54"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "4007cc8ddaceeecf565c03721c83036dfa1bd3e8e8e8873b446e152d005b6b13"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "8f8deedcaa228e1f8735f8c34ebeaa4f4d9ae10bb2ac3de899aabe202a364aa1"
    decision: version-bump
  - root: "event:assistant/peer-message"
    previous: null
    after: "836d3ad11feb3a2694d374cadaecf1eb110960d55a8e5b702c9886185567f396"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "c1e290c4d3c1ba835a93bf76e62398522299d901c02def708bb4b30eca2310cb"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "8d585cddb10057535c5e0a330b3aee41aac73a4ea3a4773e0f117e27fc2c1884"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "e0a90cfbfe3922bfe638df5359dd09197ef0932016cbbf9c5d22de7e3f1147ea"
    decision: version-bump
  - root: "event:xingchen/dispatch-progress"
    previous: null
    after: "9474bbb067c7b190f6aef17f0afaa7ca30daeaca1dc9539c040fc8e886fa3b01"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

V4 logs stay readable without hand-editing: the adjacent `session-format-v4-to-v5` migration upgrades them when a Session is opened, and every earlier generation keeps its own adjacent step, so a stored log is converted in order. A V5 log requires a V5-aware build; an older reader refuses it instead of guessing at unknown roots, and no downgrade path exists. `SessionHeader.backend` and `JsonlHeaderLine.backend` are optional, so a V4-era header that lacks them still loads and is read as the default `dsh` loop. The `ui-polish` and `a2a-seat` user-source kinds are attribution-only: a reader without their producers preserves the message and its JSON metadata, and neither kind imposes validation, replay, or authority requirements.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session packages/core/session: 145 files, 3587 tests passed (11 skipped), covering the adjacent migration chain, the V4-to-V5 codecs and validators, and the current writers. pnpm run verify-persistence-formats: v0 through v5 verified as six complete references. pnpm run verify-persistence-catalog: catalog, schema and known-event-types up to date.

<a id="dev-note"></a>
## Dev Note

None.
