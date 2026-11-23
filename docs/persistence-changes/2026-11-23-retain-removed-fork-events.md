---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-23-retain-removed-fork-events

English | [中文](2026-11-23-retain-removed-fork-events.zh.md)

## Summary

Keeps the durable declarations of seven log-only events and nine message attributions after the fork removed the qwen-code, pi, opencode, and codex capabilities that produced them; `approval/decided.outcome` returns to the upstream variant set.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-23-retain-removed-fork-events
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-11-14-approval-timeout-outcome"
    after: "304e47d57244dcff41c96e5e1dd31f21f818a799a7ff5354017944975e1bec54"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-19-cua-input-notices"
    after: "5c681e2be1021c062928224c7faf9a04f3b29d1a15fb4da86bfeba247fef2817"
    decision: same-version
  - root: "event:approval/decided"
    previous: "2026-11-14-approval-timeout-outcome"
    after: "bb1ab3d08f49a9f3b265f844cd78d5c49813062a7b34b54904b426f85d0ff6e3"
    decision: same-version
  - root: "event:assistant/peer-message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "697fc97857bcd95260c02033cea4130e94c5f1e7fb6822986d53a5ab373d37a2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "47d6fc3a9f479e2afd055a449421e31de4d5cdfee12ad2926cd125986fc6e46b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "3224dd1dfc015cbc730f9e1fe94bf833a66f4d9fa989dad530e3ceb02246dd42"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "5b2a52e7062e3934321fec05d3663769bcec9be77c455b9a7e9fa33ee9fbcc99"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Session format V5 is unchanged: no discriminator, header, role, or existing attribution changes, and every type released in 0.2.2-rc.3, 0.2.2-rc.4, and 0.2.3-alpha.2 stays recognised. The retained members live in `packages/core/session/src/retained-events.ts` and `packages/interaction/user-approval/src/retained-events.ts`; this build has no producers for them and no projection folds them, so such records keep their text and metadata without affecting reconstructed history. `approval/decided.outcome` no longer carries `timed-out`: the removed approval timeout produced it, and readers treat a value outside the upstream set as an unknown outcome rather than a decision.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes and pnpm run verify-persistence-catalog pass. pnpm run test on packages/core/session, packages/mcp/mcp-client, packages/mcp/mcp-resources, and packages/experimental/webhook ran 49 files and 1065 tests, all passing. pnpm run doc-typecheck compiled 120 blocks.

<a id="dev-note"></a>
## Dev Note

None.
