---
description: "Prompt-cache keep-alive requests that replay an idle Session's request prefix."
kind: "package-reference"
---

# @deepseek-ai/dsh-warming

English | [中文](README.zh.md)

## Summary

`dsh-warming` keeps a provider's prompt cache from expiring while a Session sits idle. After a turn ends and the configured interval elapses, it replays the Session's derived history, recorded tool declarations, and route, then appends one keep-alive prompt. Because the ping reproduces the conversation's request prefix, it refreshes the cache entry the next real request reads instead of creating a separate one. The ping never enters the Session log or derived history, and its reply is discarded. A failed ping warns once and stops warming that Session until its next real request. Disposal clears timers and aborts in-flight pings.

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

Mount the plugin in a deployment that should keep idle Sessions warm. It requires the LLM service and is opt-in: the package is not part of `dsh-base`, and every ping is a billable request.

### Configuration

- `enabled` — whether idle Sessions may be warmed. Defaults to `true`; the package itself is enabled by mounting it.
- `interval` — milliseconds to wait after the latest request before one ping, or `'auto'`. Defaults to `'auto'`, which resolves to four minutes.
- `durationMs` — how long after the latest real request warming may continue. Defaults to 30 minutes.
- `prompt` — the model-visible keep-alive text. Defaults to `This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK`.
- `maxOutputTokens` — output-token cap for one ping. Defaults to 16.
- `timeoutMs` — end-to-end ping deadline. Defaults to 15000.

## Understand the implementation

The plugin follows `session/event` for each Session. A `request/header` records that a real request was routed, and `step/start` records when the latest model call was sent. `turn/end` schedules a timer for the remaining interval; real activity (`turn/start` or `step/start`) cancels the timer and aborts a ping in flight.

When a timer fires, the ping rebuilds the request from the Session itself: `session.requestHeader()` supplies the provider/model/effort route and the tool declarations of the latest real request, `session.deriveMessages()` supplies the current derived history, and `session.toolHistory()` supplies the tool-update projection. The keep-alive prompt is appended as the final user message and nothing is appended to the Session. This is the same cache-reusing construction `@deepseek-ai/dsh-compaction-basic` uses for its summarization call.

A timer fires only while `lastSendAt + interval < lastRequestAt + durationMs`, so no ping lands at the edge of a window nothing will read afterwards. Each successful ping starts the next interval from its own send time, while the window keeps measuring from the latest real request. One failed ping — a rejected preparation, an elapsed deadline, or a provider `error`/`aborted` finish — sets the Session's stopped flag and produces a single warning; the next real request clears it.

## Further Exploration

- Auxiliary one-shot requests with their own purpose and source tags: `@deepseek-ai/dsh-followup`.
- The cache-reusing auxiliary call this package mirrors: `@deepseek-ai/dsh-compaction-basic`.
- The deadline helper and timer bound: `@deepseek-ai/dsh-timeout`.
- The reference behavior this package follows: opencode's `WarmingPlugin`.

## Model Experience

### Keep-alive requests

#### What the model sees

The conversation's own history: the system prompt, messages, and tool declarations the next real request would send, followed by the configured keep-alive prompt as one more user message. No event is appended, so the conversation itself is unchanged and the next real request does not see the prompt.

#### Token effect

The main conversation request gains zero tokens. A ping re-sends the current history plus the prompt (a fixed sentence by default); the history is served from the provider's prompt cache once warm, so only the prompt and the capped output (`maxOutputTokens`) are billed as new tokens. Neither is charged to the Session's context window.

#### KV Cache effect

The ping reproduces the request prefix the provider cached for the latest real request — same route, tool declarations, system prompt, and messages — and appends the prompt. The provider's prefix match therefore extends the cached entry's lifetime instead of creating a separate one, which is the entry the next real request reads.

## Known Limitations and Deferred Work

- `interval: 'auto'` is fixed at four minutes. No LLM adapter reports a prompt-cache TTL — `dsh-llm-pi-ai` exposes only `cacheRetention: 'none' | 'short' | 'long'` — so the 90%-of-TTL rule cannot be applied; four minutes stays under the five-minute lifetime providers commonly keep for a short-retention cache.
- No cache-miss detection. opencode stops warming when a ping writes more cache than it reads; this package does not inspect usage accounting.
- Warming starts at the first `turn/end` this process observes. A Session restored without new activity is not warmed, and compaction requests do not reset the window.
- A ping re-sends the current history, so a conversation already at its route's context ceiling can fail the ping; that failure logs the single warning and stops warming.
- No client surface: warming is observable only through provider billing and the single warning.

<a id="dev-note"></a>
### Dev Note

The route and tool declarations come from the recorded `request/header`, and the messages from the Session's derived history, rather than from the Session's current model selection: the cache entry belongs to the request that last wrote it.
