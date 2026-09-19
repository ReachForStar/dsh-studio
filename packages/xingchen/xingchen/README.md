---
description: "Give one session four star-domain roles: delegate to 天权/瑶光/天梁 specialist A2A peers under per-role charters, handle routine work as 启明, and label sessions with their role and stop reason."
kind: "package-reference"
---

# @reachforstar/dsh-xingchen

English | [中文](README.zh.md)

## Summary

`dsh-xingchen` gives one session four star-domain roles. 启明 is the harness's own coding agent and the default router; 天权 (architecture evaluation and code review), 瑶光 (bug reproduction and root-cause attribution), and 天梁 (delivery planning) are A2A peers the deployment configures. The router delegates through the `xingchen_route` tool, a person addresses a specialist with `/review`, `/bug`, or `/planning`, and every dispatch is prefixed with that role's charter, so the seat rather than the backend defines the role. The `xingchen` session projection supplies the session list's role and stop-reason labels.

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

Mount it in an agent preset; mounting it in a host composition instead would register the tool, commands, and prompt section once for the whole process, and the projection is per session. `packages/preset/agent-presets/presets/standard/agent.cordis.yml` mounts the package, and `xingchen-qiming` is the same composition with the 启明 persona.

### When to choose it

Choose it when work should reach a different agent with a different discipline — an architecture review, a bug that needs a reproduction before a diagnosis, a delivery plan. Choose [dsh-tool-a2a](../../a2a/tool-a2a/README.md) instead when the model itself should pick among peers by name; this package owns the four-role partition, the charters, and the session labels, and it uses that tools' seam underneath.

### Minimal configuration

```yaml
- name: '@reachforstar/dsh-xingchen'
  config:
    peers:
      tianquan: claude-code
      yaoguang: pi
      tianliang: opencode
```

| Field | Default | Meaning |
|---|---|---|
| `peers.tianquan` | `claude-code` | A2A peer serving 天权 |
| `peers.yaoguang` | `pi` | A2A peer serving 瑶光 |
| `peers.tianliang` | `opencode` | A2A peer serving 天梁 |
| `charters.<role>` | package charter | Replace one role's charter text |

Each peer name must exist on the `a2a` row's `peers` map. The generated [configuration catalog](../../../docs/config-catalog.md#reachforstardsh-xingchen) carries every field.

## Understand the implementation

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `XingchenService`: role bindings, dispatch with per-session peer continuity, the `xingchen_route` tool, the three commands, the routing prompt section, the projection registration |
| [`src/route.ts`](src/route.ts) | Role names, summaries, the command-to-role maps, and the model-free `routeXingchen` classifier |
| [`src/charters.ts`](src/charters.ts) | The three specialist charters (persona plus working discipline) |
| [`src/skills.ts`](src/skills.ts) | The `./skills` entry: registers the bundled `git`, `run`, and `log` skills from the package's assets |
| [`src/clear.ts`](src/clear.ts) | The `/clear` command, mounted inside a preset compaction group |
| [`src/types.ts`](src/types.ts) | Pure domain types and the `SessionProjectionMap` merge |

### Export shape

The module exports `name`, `Config`, the service, and `apply`, with **no default export**: the Loader's `unwrapExports` collapses a module that has one, which drops `inject` and `Config` at load ([postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)). `./clear` is a second entry with its own `name`, `inject`, and `apply`, because `/clear` must share the compaction realm of the preset that mounts it.

### Dispatch and continuity

A dispatch sends the role's charter, a separator, and the task as one A2A message. The reply's `contextId` is remembered per `session id + role`, so a second dispatch to the same role continues the peer's conversation while another role starts its own. Continuations are process-local: the peer's history survives a restart, this map does not.

### Session projection

`xingchenProjectionDefinition` folds three event types into `{ lastRole, dispatchCount, lastTurnReason }`. A `command/run` naming a role command, or a `tool/call` naming `xingchen_route` with a recognized role, records the role and increments the count; `turn/end` records the cropped stop reason. Malformed logged arguments leave the state untouched instead of failing the fold, because a projection replays whatever the log holds.

### Bundled skills

The `./skills` entry registers three bundled skills into the session's catalog: `git` (read history, blame, and the commit that introduced a defect), `run` (execute a reproduction or a focused test and report the real result), and `log` (parse a log or stack trace into the evidence that names a failure). They are model- and user-invocable, so `$git`, `$run`, and `$log` work in the composer and the router agent can load them by name. Each skill ships as `skills/<name>/SKILL.md` and is served from this package's own assets; `assetRoot` points at another directory for a packaged install.

## Further Exploration

- [Xingchen subsystem page](../../../docs/subsystems/xingchen.md) — the generated `ctx.xingchen` API beside the role and projection description.
- [A2A stack](../../a2a/README.md) — the peer seam this package dispatches through.
- [Agent presets](../../preset/agent-presets/README.md) — how `xingchen-qiming` and `standard` compose this package.

## Model Experience

### Request context and condition

#### What the model sees

The `xingchen:routing` prompt section (ordered with the plan policy) names the four roles and when to call `xingchen_route`; the router agent's own persona is the preset's, not this package's. The `xingchen_route` tool schema exposes `role` (one of the three specialist ids) and `task`, with a description stating that the specialist cannot see this workspace and that the call waits for the specialist to finish. See the generated [tool catalog](../../../docs/tool-catalog.md) for the exact schema. A peer's answer returns as the tool result text, prefixed with the role's Chinese name.

#### Token effect

The prompt section adds a fixed block to every request of a session on this preset. The skill catalog contributes its own reminder listing each bundled skill's description. A dispatch adds its own JSON arguments and the peer's full answer; the answer is not summarized, so a long specialist report costs its full length in the caller's context.

#### KV Cache effect

The prompt section text and the tool schema are fixed per deployment, so neither invalidates a reusable prefix. Commands register no prompt text of their own.

## Known Limitations and Deferred Work

- **Specialists are external peers.** The package routes to A2A endpoints; there is no in-process specialist preset, so a deployment without configured peers cannot use 天权/瑶光/天梁 at all and each dispatch fails with the peer error.
- **Continuation is process-local.** The `session id + role` to `contextId` map lives in memory, so a restart starts a fresh peer conversation even though the peer may still hold the old one.
- **One dispatch at a time per call.** `xingchen_route` returns only when the specialist finishes; a long review blocks the calling turn, and there is no streaming of partial specialist output.
- **The heuristic is advisory.** `routeXingchen` classifies without a model, but only the routing agent's tool call and the slash commands actually dispatch; no client or host path consumes the classifier yet.
- **No defect-family history.** The 季节回归 (seasonal regression) linkage the 瑶光 charter asks the specialist to keep is the specialist's own record; this package stores no cross-session bug family.

### Dev Note

The routing design — three external seats over A2A rather than three shipped local presets — and the projection's role/stop-reason shape are recorded in the [Xingchen subsystem page](../../../docs/subsystems/xingchen.md).
