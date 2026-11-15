# Agent Note: Write ignorable markers for shipped log-only events

Status: implemented

English | [中文](2026-11-15-ignorable-declared-log-only-events.zh.md)

## Problem

`session-title-llm` records two auxiliary events, `session/title-llm-request` and `session/title-llm-usage`, as declared `SessionEventMap` members. Declared members are required-on-read, so a build whose vocabulary lacks them refuses the whole session with `contains event type "session/title-llm-usage" (seq 18) unknown to this harness and not marked ignorable`. That refusal is correct for state-changing events, but these two records are purely informational token-accounting: dropping them cannot change how the rest of the log is interpreted.

Before this note the envelope's `ignorable` marker had exactly one first-party writer, `appendPluginRecord()`, which is restricted to `packages/experimental/` and the `plugin:` namespace. A release package therefore had no way to ship an informational event that keeps sessions readable across builds, and the alternative — writing them from a shipped package — breaks every reader that predates the declaration.

## Decision

`Session.append()` accepts `LogOnlyEventOptions` (`{ ignorable?: true }`) for event types outside `SurfaceEventType`; the third positional element of `SessionEventInput` carries it for the same types. `snapshotAppend` writes the marker into the committed envelope, and it rejects the marker on surface-eligible (message) types: the model-visible surface never contains an ignorable event, and silently dropping message history would reconstruct a different conversation. The runtime guard and the type-level overload work together, so a caller cannot mark a message ignorable and a non-surface type cannot carry surface metadata.

`session-title-llm` passes `{ ignorable: true }` on both auxiliary records. The marker's effect is limited to readers: a build that knows the types keeps reading them (token accounting is unaffected), while a build without the declaration retains the record and skips it instead of refusing the session. Declared state-changing events keep the required-on-read default; the marker must be justified per record by the fact that its loss cannot affect reconstruction.

The `plugin:` record path is unchanged: it remains the experimental-only escape hatch whose retention across format migrations is best-effort. This note extends the envelope's writer inventory without changing record admission, `KNOWN_SESSION_EVENT_TYPES`, or `SESSION_FORMAT_VERSION`; the marker is per-record envelope data the current and adjacent-format readers already admit.

## Alternatives considered

**Keep every declared event required-on-read.** Rejected: the user-visible failure is exactly that, and it recurs whenever a shipped package adds informational accounting, because each addition locks out every older build that shares the installation.

**Write the title records as `plugin:` records.** Rejected: the caller restriction exists so release packages cannot keep state a format migration may drop, and the records would change type identity — stored sessions already carrying `session/title-llm-*` would need a second vocabulary entry anyway.

**Accept an allowlist of known-informational unknown types at read time.** Rejected: it cannot help the older readers that already exist, and it moves an admission decision from the writer (which knows the payload's role) to the reader (which cannot infer whether omission is safe).

**Mark informational events ignorable implicitly, by type name.** Rejected: the marker must stay an explicit writer judgment; defaulting to required keeps a forgotten marker over-refusing rather than silently resuming a gutted session.

## Consequences

Shipped informational events now keep sessions readable across builds that ship different vocabularies, while state-changing events and message history still refuse loudly when unknown. A reader without the declaring package loses that accounting data and nothing else. Writers must keep the judgment explicit: only events whose loss cannot affect reconstruction may pass the marker, and a future event that carries state must not copy this pattern.
