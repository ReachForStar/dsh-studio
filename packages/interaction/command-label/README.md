---
description: "Human-facing /label command that marks a session entry for navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-label

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-command-label` to attach a short label to the last assistant message of a session. The label is log-only session metadata: it never enters the model surface, and it survives resume because it is folded from durable events. Labels are navigation markers for the transcript and future UI surfaces. Mount it when users want to bookmark a point in a long session.

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

Mount the plugin in a composition that provides the command registry and session projections, then run `/label <name>` or `/label clear` in an interactive UI.

```yaml
- name: '@deepseek-ai/dsh-command-label'
```

The command labels the most recent assistant message. `clear` removes the label from that same entry. Label text is trimmed and must be 1–80 characters.

```text
/label checkpoint-1
/label clear
```

The command is a human command: its input and result are recorded by the command lifecycle. The label itself is recorded as a separate log-only `session/label` event.

<a id="understand-the-implementation"></a>
## Understand the implementation

The command appends a `session/label` event naming the target entry sequence and the label text, or a null label to clear it. A host-only projection folds those events into one label per entry, so resume and fork inheritance replay the same label state. The projection is registered through the session projection registry and needs no client view.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-session`](../../core/session/README.md) — the event log and projection inputs.
- [`dsh-commands`](../commands/README.md) — the command registry and execution lifecycle.

<a id="model-experience"></a>
## Model Experience

### Session label

#### What the model sees

Nothing. `session/label` is log-only and carries no surface operation, so it never enters derived history, the system prompt, tool schemas, or a request prefix.

#### Token effect

Zero. The event adds no model-visible token and changes no request content.

#### KV Cache effect

None: the conversation's reconstructed content and cache key are unchanged.

## Known Limitations and Deferred Work

- The command labels only the last assistant message; labeling an arbitrary earlier entry is not implemented.
- No client rendering consumes the label projection yet.
- Labels are per entry sequence; a label does not move when an entry is rewritten by a surface replacement.

<a id="dev-note"></a>
### Dev Note

The label binds to an entry sequence rather than a message id so that fork-inherited prefixes keep the same label without copying per-message metadata.
