# Agent Note: Full access is an approval commit, not an allow rule

Status: implemented

English | [中文](2026-11-14-approval-full-access-commit.zh.md)

## Problem

A person who is asked to approve one sandboxed action may conclude that the session should run unconfined from then on. Treating that conclusion as another `allow` rule is wrong in two ways: a rule is a persistent pattern wider than the request it matched, and it would cover input queued after the person looked at the prompt. Codex and ZCode both make the same move — a distinct commit action with a durable receipt and a busy check — but their session model also stamps a mode onto each queued item.

DSH resolves the sandbox mode from the Session projection at execution time, so a mode switch already reaches every queued item; there is nothing to stamp. What still needs an owner is the act itself: which prompt was granted, what it covered, and what happens when the same prompt is answered twice or while another grant is settling.

## Decision

`dsh-user-approval` owns the commit and its receipt. `request()` now mints the request identity that answerers receive as `requestId`, and while an applier is registered the dispatched request carries `fullAccess: true`. `registerFullAccess(handler)` installs that one applier. `requestFullAccess(agent, requestId)` requires that exact prompt to still be pending, refuses a concurrent commit for the same session, appends one `approval/full-access` receipt holding the pending input identities, and only then runs the applier. A retry for the same request reuses the receipt instead of taking a fresh target snapshot, so input queued after the first commit stays outside the grant. A failing applier leaves the receipt in place for a retry with the same targets.

`dsh-permission-presets` owns what full access means: it registers the applier and applies `fullAccessPreset` (default `danger-full-access`) through the same write path as `/permission`. An explicitly configured missing preset fails at load; a replacement table that merely omits the shipped default withdraws the action. The browser reaches the commit through `/full-access <requestId>` and answers the prompt only after the command succeeds, so a refused commit keeps the prompt open.

The receipt is an audit record, never a rule: it grants nothing to later requests. `SESSION_FORMAT_VERSION` stays unchanged because an unknown required event makes older readers refuse the log rather than interpret a grant that is missing.

## Alternatives considered

- A dedicated `allowed-full-access` approval outcome would have let answerers return the widening directly, but it would put policy application inside the approval waterfall and lose the receipt-first ordering that makes a failed applier retryable.
- A persistent rule derived from the prompt is the behaviour this change rejects: it outlives the prompt and covers input the person never saw.
- Snapshotting targets in the client would let a delayed command widen the grant beyond what the prompt covered.

## Consequences

Answerers and clients see two additional optional request fields; older clients ignore them and keep the two-outcome card. The applier is the only component allowed to write the wider policy, so a deployment without `dsh-permission-presets` advertises no full-access action instead of failing per click. Concurrent commits are rejected rather than serialized, which surfaces the one-at-a-time rule to the user instead of silently merging two grants.

Verification: `packages/interaction/user-approval/tests` covers the receipt, fixed targets, idempotent retry, stale prompt, missing applier, and busy rejection; `packages/interaction/permission-presets/tests/full-access.spec.ts` covers the preset application and the `/full-access` command; `packages/client/ui-approval/tests` covers the gated action, acknowledgement, and failed-command behaviour.
