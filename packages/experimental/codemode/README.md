---
description: "Sandboxed JavaScript execution where the only capability is calling injected tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-codemode

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-codemode` to let the model write a JavaScript script that calls the session's tools and non-LLM models. The script runs in a Node `vm` sandbox with no filesystem, network, or timers; the only way out is `tools` and `models`. Only the script's output reaches the model, so a script can run calls in parallel and filter large results first. Mount it when the model should batch tool work instead of one call per turn.

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

Mount the plugin in a composition that provides the tools and LLM services. It registers one model tool, `run_code`.

```yaml
- name: '@deepseek-ai/dsh-codemode'
  config:
    timeoutMs: 30000
    maxOutputChars: 16000
```

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `30000` | Deadline for synchronous script execution |
| `maxOutputChars` | `16000` | Output cap; longer output keeps its start and end |

### Script globals

| Global | Purpose |
|---|---|
| `tools.<name>(args)` | Call a visible tool; names that are not valid identifiers use `_` |
| `text(value)` | Add one output item |
| `return value` | Add the returned value as output |
| `store(key, value)` / `load(key)` | Keep a JSON value across calls |
| `models.classify(request)` / `models.generateImages(request)` | Run a non-LLM model through the LLM service |
| `exit()` | End the script successfully |

The script runs as an async function body, so top-level `await` and `return` work. A failed script keeps its partial output and reports the error.

<a id="understand-the-implementation"></a>
## Understand the implementation

The service builds a `node:vm` context per run. It enumerates the agent's visible tools and binds each name to a host function that dispatches through `ctx.tools.execute`, so tool policy, approval, and logging apply unchanged. Non-LLM models route through `ctx.llm.classify` / `generateImages`. The script runs as an async wrapper so top-level `await` is allowed, and output is collected through `text` and the return value.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-tools`](../../core/tools/README.md) — the tool registry and execution that every injected call uses.
- [`dsh-llm`](../../llm/llm/README.md) — the non-chat model methods.

<a id="model-experience"></a>
## Model Experience

### Codemode script

#### What the model sees

Only the script's own output. The sandbox globals, the script source, and every intermediate value stay inside the tool result; the model never sees another tool's schema through `tools`.

#### Token effect

One tool result replaces the whole script's intermediate traffic, so parallel calls and large tool outputs are filtered before they reach the conversation. The script source is one tool-call argument.

#### KV Cache effect

The tool call is an ordinary tool round; the request prefix is unchanged until the tool result is appended.

## Known Limitations and Deferred Work

- `timeoutMs` bounds synchronous execution only; a script awaiting a slow tool is bounded by that tool's own signal.
- `store` is process memory keyed by string, not persisted in the session log or a projection.
- The sandbox exposes `console`; output from `console` is not collected.
- Nested `run_code` calls are not supported.

<a id="dev-note"></a>
### Dev Note

The sandbox deliberately binds tool names from the live registry per run, so a scope or restriction change applies to the next script without restarting the process.
