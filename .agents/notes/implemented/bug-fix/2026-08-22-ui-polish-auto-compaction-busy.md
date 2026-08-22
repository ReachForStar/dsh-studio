# Agent Note: Fix ui-polish auto-compaction calling the idle-only manual API mid-turn

Status: implemented

English | [中文](2026-08-22-ui-polish-auto-compaction-busy.zh.md)

## Problem

`dsh-client-ui-polish` lets the user pick the context-pressure ratio at which the session compacts below the harness default (0.8). Its `compaction-control.ts` intercepted `agent/pre-step` and called the agent-addressed `compaction.compactNow(agent, signal)`. `compactNow` is the explicit idle-session API: it enters agent maintenance through `runMaintenance()`, which throws synchronously unless the agent phase is `idle`. A pre-step listener runs while the phase is `running`, so every automatic attempt threw `ManualCompactionError('busy')`, was swallowed into a per-step warning, and never compacted — context kept growing past the user's ratio until the harness's own 0.8 listener or a manual `/compact` intervened. The same busy error surfaced to the user when `/compact` was attempted while a turn was streaming, so the broken interception read as "auto-compaction broken AND it blocks manual compaction".

## Decision

The mid-turn-safe seam method is `compactIfNeeded(agent, 'pressure', signal)`, which owns range selection, retention, retry, and the durable lock markers; the built-in automatic listener already uses it from the same event. What it lacked was a way for a caller to lower the pressure bar below the backend's configured threshold. So:

- The compaction Service Definition (`dsh-compaction`) gained an optional per-call `options?: PressureTriggerOptions` on `compactIfNeeded`; `thresholdRatio` overrides the backend's configured threshold for that call only.
- `dsh-compaction-basic` honors it in `resolveCompactSpec(policy, contextWindow, override?)`: the pressure bar scales with the override, retention and retry budgets stay the backend's, and the existing `retainTokens < thresholdTokens` validation still runs.
- `ui-polish` now measures nothing itself; it calls `compactIfNeeded(agent, 'pressure', signal, { thresholdRatio: ratio })` when a ratio below 0.8 is configured and stays a no-op at or above it. The built-in listener then measures below the user's ratio (< 0.8) and does not double-compact.

Manual `/compact` is untouched: `compactNow` still owns the idle-maintenance path and is never invoked mid-turn.

## Alternatives considered

**Keep `compactNow` and make it tolerate a running phase.** Rejected: `compactNow`'s contract is the idle maintenance reservation (withhold waking input, flush before queue replay); widening it to mid-turn work would duplicate `compactIfNeeded` and blur the manual API's guarantees.

**Reconfigure compaction-basic from the host.** Rejected: the Web composition mounts compaction-basic inside the agent preset's isolated realm precisely so a host plugin cannot reach or reconfigure that instance; a per-call override keeps policy static and the interception local to ui-polish.

**Expose range selection (`selectCompactableRange`) to host plugins.** Rejected: it would force ui-polish to reimplement selection, retention, and retry policy instead of reusing the backend's, and it would leak backend internals through the seam.

## Testing

`compaction-basic.spec.ts` covers the per-call override at both the `resolveCompactSpec` level (scaled bar, retention untouched, invalid-ratio and retention-collision rejection) and the `compactIfNeeded` level (compacts below the configured bar with an override; holds when the override raises the bar). The seam, command-compact, and ui-polish suites pass unchanged.

## Consequences

- User-configured ratios below 0.8 now actually compact, mid-turn, through the same proven path as the built-in 0.8 listener.
- The per-step busy warning spam is gone, and manual `/compact` no longer competes with a broken automatic attempt.
- The seam gained a small additive surface; optional means other backends keep working, and the generated Cordis API catalog and subsystem pages track the signature.
