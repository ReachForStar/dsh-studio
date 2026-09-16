---
description: "Drive a dsh session with the Pi coding-agent runtime, sharing dsh's session log, tools, and persistence while Pi owns the turn loop."
kind: "package-reference"
---

# @deepseek-ai/dsh-pi-agent-loop

English | [中文](README.zh.md)

## Summary

Use this package to run a dsh agent whose turn loop is the Pi coding-agent runtime instead of the default dsh loop. Mount it to offer `backend: 'pi'` sessions beside `dsh` sessions: the session keeps dsh's durable log, header metadata, and tool policy, while Pi opens the model session, streams assistant output, and calls tools. Choose it when a deployment wants Pi's provider breadth — including OpenAI-compatible gateways — under the harness's session and persistence model. The two loops are alternatives, not layers: only one drives a given session, and its backend is recorded in the session header.

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

Mount the plugin beside the default loop; it registers itself as the `pi` agent factory.

### When to choose it

Choose it for a deployment that already standardizes on the Pi runtime for model access, or that needs a Pi-only provider route in a dsh session. Prefer the default dsh loop when the session needs the dsh loop's own extension points, for example live steering through the agent inbox, or when the deployment cannot install a `pi` runtime. Both loops are available in one process, so selection happens per session rather than per deployment.

### Minimal configuration

```yaml
- id: pi-agent-loop
  name: '@deepseek-ai/dsh-pi-agent-loop'
  config:
    model:
      provider: amax
      modelId: qwen-3.8-27B
    providers:
      - id: amax
        baseUrl: https://ai.amaxsmp.com/v1
        apiKeyEnv: AMAX_API_KEY
        models:
          - id: qwen-3.8-27B
            name: Qwen 3.8 27B
            contextWindow: 262000
            maxTokens: 32000
```

| Field | Default | Meaning |
|---|---|---|
| `model` | `required` in practice | The Pi route every session uses, as `provider` and `modelId`; winning over dsh's `agentOptions.provider`/`model`, which names dsh adapters rather than Pi providers. |
| `providers` | `[]` | OpenAI-compatible gateways registered into Pi before model selection, each with its own `apiKeyEnv` and model list. |
| `openSession` | the real Pi opener | Replaces the session opener for tests; never set it in a deployment. |

## Understand the implementation

The plugin registers an [`AgentFactory`](../../../docs/agent-lifecycle.md) under the `pi` backend. `createAgent` prepares a dsh session, stores its durable identity through `sessionPersistence`, opens one Pi session, and publishes the agent; `resume` reopens the persisted log, appends closers for interrupted turns, restores the header `cwd`, and rehydrates Pi from that history before publishing. The session header records `backend: 'pi'` so a later resume routes back to this loop.

### Session and event ownership

dsh owns the session log, and Pi's stream is translated into dsh events: assistant text, tool calls, and results reach the log through the same event types the default loop writes, so projection, telemetry, and persistence consumers stay loop-agnostic. The translator modules (`pi-session`, `pi-event-translator`) own that mapping.

### Tool sharing

Tools cross the boundary in both directions. `dsh-tool-adapter` exposes each dsh tool to Pi as a Pi custom tool whose TypeBox parameters mirror the dsh declaration, and dsh still re-validates inside `ToolRuntime.execute`, so the tool policy pipeline, approval, and hooks keep applying. `pi-tool-adapter` exposes Pi-registered tools (extensions and skills) back to dsh's own tool surface.

## Further Exploration

- [dsh-agent](../agent/README.md) — the agent lifecycle and `AgentFactory` contract this package implements.
- [session persistence](../../../docs/subsystems/persistence.md) — the durable log a Pi-backed session writes through.
- [dsh-tools](../tools/README.md) — the tool runtime both adapters feed.
- The keyless translator and adapter specs run without credentials; `pi-loop.e2e.ts` and `pi-session.e2e.ts` drive a real gateway and self-skip without `AMAX_API_KEY`.

## Model Experience

### Session start

#### What the model sees

Pi's own system prompt and tool declarations for the configured route, plus dsh tools adapted into Pi custom tools by `dsh-tool-adapter`. dsh's `ctx.systemPrompt` assembly does not run for a Pi-backed session.

#### Token effect

The prompt carries the adapted dsh tool declarations instead of dsh's own rendering of them; the two are equivalent in parameter contract, not byte-identical.

#### KV Cache effect

Independent of any dsh-loop cache: reuse depends only on Pi's provider, model, instructions, and tools.

### Tool call

#### What the model sees

The tool result as Pi renders it after the adapted dsh tool ran through the `ctx.tools` execution pipeline.

#### Token effect

Unchanged from the default loop: the result is the same canonical JSON the dsh pipeline produced.

#### KV Cache effect

Append-only: the new tool result follows the reusable prefix of the request that carried the call.

## Known Limitations and Deferred Work

- **Pi owns the turn loop** — dsh's agent inbox is inert for a Pi-backed session: queued or steered messages are not injected into a running Pi turn, and this backend does not emit `agent/session-start`, which Pi replaced with `agent/created`.
- **No live-tool parity guarantees** — adapted tools preserve the parameter contract and revalidate in dsh, but a Pi-side tool feature without a dsh equivalent (for example a Pi-specific streaming update) is dropped rather than approximated.
- **Model routes need explicit declaration** — the Pi runtime resolves only the providers this configuration registers plus its own ambient configuration; a route named only by a dsh adapter does not reach Pi.
- **Resume requires persistence** — resuming a Pi-backed session without the `sessionPersistence` service fails loud.
- **Evidence baseline is pinned to one Pi version** — the adapter specs and the credentialed end-to-end scenarios were recorded against the pinned `@earendil-works/pi-coding-agent` version; upgrading it requires re-verifying the translator, both adapters, and the end-to-end scenarios.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The keyless specs cover the event translator and both tool adapters; `pi-loop.e2e.ts` and `pi-session.e2e.ts` drive a real gateway and self-skip without `AMAX_API_KEY`.

</details>
