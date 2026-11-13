---
description: "Session side questions answered from the completed history without adding a turn."
kind: "package-reference"
---

# @deepseek-ai/dsh-btw

English | [中文](README.zh.md)

## Summary

Use this package when a user wants to ask one question about the current conversation without adding it to the main transcript. The Session Header offers `Ask about this session`; the question runs in a forked child of that Session, which inherits the completed-turn context and reports to the caller instead of the parent model. The answer appears in a modal and the parent conversation gains no turn. The Host owns the authenticated route and the fork lifecycle; the browser owns the dialog and its menu action.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in a bundle that provides Agents, subagents, Connection, and the browser slot registry. The default subagent provider is `fork`, which must be registered by the composition (`dsh-subagent-fork-in-process`).

```yaml
- name: '@deepseek-ai/dsh-btw'
  config:
    provider: fork
    maxQuestionChars: 4000
    timeoutMs: 120000
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `fork` | Subagent provider that inherits the parent's completed-turn context |
| `maxQuestionChars` | `4000` | Longest accepted question |
| `timeoutMs` | `120000` | Wall-clock budget for one question |

### Request contract

`POST /api/btw.ask` takes `{ "sessionId": "…", "question": "…" }` and answers `{ "answer": "…" }`. It returns `400` for a malformed body or question, `404` for an unknown Session, `502` when the child did not complete, `504` on timeout, and `500` for an opaque provider failure. The child is disposed after every outcome.

### What the model sees

Nothing in the parent Session: the fork inherits history for its own request, and its answer is returned only over the route. The child Session itself is a normal catalogued Session, so it remains available to the Session list.

## Model Experience

### Side question

#### What the model sees

The parent Session sees nothing: `POST /api/btw.ask` adds no prompt section, tool schema, request-context value, or user message there. The forked child runs one ordinary request with the inherited completed-turn history, created through `ctx.subagents.startActivation` with `delivery: 'caller'`.

#### Token effect

No parent tokens. The child pays for one ordinary request over the inherited history it already carries.

#### KV Cache effect

No change to the parent's request prefix; a child request is a separate Session with its own cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Answers are text only; images and structured output are not projected back.
- Each question starts a forked child Session, so asking several questions leaves several child entries in the workspace.
- The dialog does not stream partial answers; it shows the final text when the child settles.
- Cancelling the dialog does not cancel a question already accepted by the Host.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Host route creates one forked child per question through `ctx.subagents.startActivation` with `delivery: 'caller'`, so the parent model is not notified. `provider` must name a provider whose `inheritsParentContext` is true for the answer to see the conversation; `fork` is the default and the only provider verified here.

</details>
