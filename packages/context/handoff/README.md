---
description: "Human-facing /handoff command that drafts a self-contained prompt for a new session from the current conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-handoff

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-handoff` to turn the current conversation into a self-contained prompt for a new session. The `/handoff <goal>` command reads the session's derived model-visible history, asks one auxiliary model to write a prompt that carries the relevant context, decisions, files, and the next task, and returns that prompt as the command result. The current session is never modified: no message is appended, no history is rewritten, and the auxiliary reply never enters the model surface. Mount it in a profile whose users want to move work to a fresh session without losing context.

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

Mount the plugin in a composition that already provides the command registry and an LLM adapter, then run `/handoff <goal for the next session>` in an interactive UI. The command is a human command: its input and result are recorded in the session log, and the result is rendered directly by the dispatching UI instead of becoming a model message.

### Configure the auxiliary route

The command uses an explicit `provider`/`model` pair when both are configured, and otherwise falls back to the session's current model selection. A half-configured pair is rejected when the plugin loads.

```yaml
- name: '@deepseek-ai/dsh-handoff'
  config:
    provider: deepseek
    model: deepseek-chat
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | absent | Auxiliary provider route; must be paired with `model` |
| `model` | absent | Auxiliary model id; must be paired with `provider` |
| `maxOutputTokens` | `2048` | Output-token cap for the one auxiliary request |
| `timeoutMs` | `30000` | End-to-end deadline for the auxiliary request |
| `maxHistoryMessages` | `40` | How many of the most recent derived messages are sent |

An empty goal is rejected with a usage line, so the composer keeps the input.

<a id="understand-the-implementation"></a>
## Understand the implementation

The command handler validates the goal, resolves the route, and calls the auxiliary request. The request replays the session's derived history, truncated to the most recent `maxHistoryMessages` entries, and appends the goal as one user message. It streams through the ordinary LLM service with `purpose: 'handoff'`, and collects text blocks into the returned prompt. The request is not logged as conversation history; the command lifecycle events own the input and the result.

The command registers through `ctx.commands.register()` with a stable branded definition id. It is a global command, so every composed command adapter can dispatch it.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-commands`](../../interaction/commands/README.md) — the command registry and execution lifecycle.
- [`dsh-llm`](../../llm/llm/README.md) — the auxiliary request path and `purpose`.
- [`dsh-followup`](../followup/README.md) — another auxiliary request that produces presentation data instead of a user prompt.

<a id="model-experience"></a>
## Model Experience

### Handoff prompt draft

#### What the model sees

The configured auxiliary model sees the session's derived history, truncated to the most recent `maxHistoryMessages` messages, plus one user message carrying the goal, and a fixed system instruction that asks for the prompt text alone. The current session's model never sees this request: no message is appended to the conversation and the draft never enters derived history.

#### Token effect

The main conversation request gains zero tokens. The auxiliary request sends the truncated history and the goal, and receives at most `maxOutputTokens`; neither is charged to the conversation window.

#### KV Cache effect

None for the main request: the command changes neither the conversation's reconstructed content nor its cache key. The auxiliary request has its own prefix and is not part of the conversation's cache.

## Known Limitations and Deferred Work

- The prompt is a draft: the user must paste it into a new session. Automatic creation of a seeded session is not implemented.
- The derived history is truncated by message count, not by a byte budget, so one very large message can still dominate the request.
- The auxiliary request has no separate durable usage record; its cost is visible through the ordinary token accounting of the LLM service.

<a id="dev-note"></a>
### Dev Note

The command is a human command, so its input and result are recorded by the command lifecycle while the auxiliary request stays out of the conversation surface.
