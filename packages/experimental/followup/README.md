---
description: "Model-suggested next steps for the user after each completed turn, logged for presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-followup

English | [中文](README.zh.md)

## Summary

`dsh-followup` proposes concrete next actions for the user after a completed turn. A `turn/end` whose turn carries request or reply text starts one auxiliary model request; the parsed lines are logged as a latest-wins `followup/suggestions` event and never enter the model surface. Requests are bounded by rendered input bytes, an output-token cap, a suggestion count, a per-suggestion character cap, and a deadline. A failed or disposed request logs a warning and leaves the conversation untouched.

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

Mount the plugin where the client should offer follow-up actions. The plugin requires the LLM service and an explicit `provider`/`model` route.

### Configuration

- `provider` / `model` — the auxiliary route; both are required together.
- `maxOutputTokens` — output-token cap. Defaults to 256.
- `timeoutMs` — end-to-end deadline. Defaults to 15000.
- `maxInputBytes` — UTF-8 byte cap on the conversation excerpt. Defaults to 8192.
- `maxSuggestions` — accepted suggestions per turn. Defaults to 3.
- `maxSuggestionChars` — characters per suggestion. Defaults to 120.

The package is not part of `dsh-base`: each turn costs one extra request.

## Understand the implementation

The plugin accumulates the open turn's user request text and last assistant reply from delivered events, keyed by the `turn/start` it saw; no historical reads are involved. On `turn/end` it renders the excerpt, calls the auxiliary route, parses plain lines into at most `maxSuggestions` actions, and appends `followup/suggestions` with the turn. Replayed `turn/end` events are ignored, and disposing the plugin aborts in-flight requests.

## Further Exploration

- Log-only latest-wins events: the `session/title` event in `@deepseek-ai/dsh-session-title`.
- Auxiliary request execution: `@deepseek-ai/dsh-session-title-llm`.
- Persistence record for this event: `docs/persistence-changes/2026-11-11-followup.md`.

## Model Experience

### Follow-up suggestions

#### What the model sees

Nothing. `followup/suggestions` is log-only: it carries no surface operation and never enters derived history, the system prompt, tool schemas, or a request prefix. The auxiliary request is a separate one-message call with its own system prompt.

#### Token effect

The main agent request gains zero tokens. The auxiliary request sends at most `maxInputBytes` of excerpt text and receives at most `maxOutputTokens`; neither is charged to the conversation window.

#### KV Cache effect

None for the main request: the event does not change its reconstructed content or cache key.

## Known Limitations and Deferred Work

- No client rendering: the event is logged, but no bundled web card consumes it yet.
- No speculation: predicted inputs are not executed ahead of the user.
- No deduplication against earlier turns: each turn's suggestions are independent.
- No redaction: request and reply excerpts are sent to the auxiliary route as-is.

### Dev Note

Suggestions are derived data, so the plugin only appends a presentation event after the turn closed.
