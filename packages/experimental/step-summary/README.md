---
description: "One-line model summaries of each step's tool batch, logged for presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-step-summary

English | [中文](README.zh.md)

## Summary

`dsh-tool-summary` writes a one-line summary of each completed step's tool batch. A completed `step/end` whose batch holds at least one tool call starts one auxiliary model request; the accepted reply is logged as a latest-wins `tool/batch-summary` event and never enters the model surface. Requests are bounded by rendered input bytes, an output-token cap, and a deadline, and a step whose batch is empty or replayed produces no request. A failed or disposed request logs a warning and leaves the conversation untouched.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a session that should show what its tool batches did. The plugin requires the LLM service and an explicit `provider`/`model` route, so an auxiliary model is always chosen deliberately.

### Configuration

- `provider` / `model` — the auxiliary route; both are required together.
- `maxOutputTokens` — output-token cap for one summary request. Defaults to 64.
- `timeoutMs` — end-to-end deadline. Defaults to 15000.
- `maxInputBytes` — UTF-8 byte cap on the rendered batch description. Defaults to 16384.
- `maxSummaryChars` — character cap on the accepted line. Defaults to 160.

The package is not part of `dsh-base`: summaries cost an extra request per tool batch, so profiles opt in.

## Understand the implementation

The plugin listens to delivered session events and accumulates each step's `tool/call` and `tool/result` entries in memory; no historical event reads are involved, so the summary path never depends on log scans. On `step/end` it renders the batch with one line per call plus a bounded result excerpt, calls the auxiliary route, and appends `tool/batch-summary` with the turn, step, summary, and call count. Replayed `step/end` events and duplicate call ids are ignored, and disposing the plugin aborts in-flight requests.

The summary is presentation data. Recording it as a latest-wins log event lets a client rebuild the same line after resume without making it model-visible.

## Further Exploration

- Auxiliary request execution with route, deadline, and usage records: `@deepseek-ai/dsh-session-title-llm`.
- Log-only latest-wins events: the `session/title` event in `@deepseek-ai/dsh-session-title`.
- Persistence record for this event: `docs/persistence-changes/2026-11-11-tool-summary.md`.

## Model Experience

### Tool batch summary

#### What the model sees

Nothing. `tool/batch-summary` is log-only: it carries no surface operation, never enters derived history, the system prompt, tool schemas, or a request prefix. The auxiliary request itself is a separate single-message call with its own system prompt.

#### Token effect

The main agent request gains zero tokens. The auxiliary request sends at most `maxInputBytes` of rendered batch text and receives at most `maxOutputTokens`; neither is charged to the conversation window.

#### KV Cache effect

None for the main request: the event does not change its reconstructed content or cache key.

## Known Limitations and Deferred Work

- No client rendering: the event is logged, but no bundled web card consumes it yet.
- No batching across steps: each step's batch is summarized independently.
- No retry: a failed auxiliary request leaves the step without a summary.
- No redaction: result excerpts are sent to the auxiliary route as-is.

### Dev Note

Summaries are derived data, so the plugin never mutates conversation state; it only appends a presentation event after the batch completed.
