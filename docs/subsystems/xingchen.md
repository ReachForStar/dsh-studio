# Xingchen (star-domain routing)

English | [中文](xingchen.zh.md)

Xingchen gives one session four star-domain roles. 启明 (Qiming) is the native coding agent — the harness's own agent, whose preset persona carries the routing discipline. 天权 (Tianquan), 瑶光 (Yaoguang), and 天梁 (Tianliang) are specialist seats:  architecture evaluation and code review, bug reproduction and root-cause attribution, and delivery planning. A seat runs in this process as a delegated child agent by default, or on an [A2A](a2a.md) peer the deployment configures. The package adds the delegation tool, the three slash commands, a routing prompt section, and the `xingchen` session projection the session list reads for its role and stop-reason labels.

Source: [`packages/xingchen/xingchen/src/index.ts`](../../packages/xingchen/xingchen/src/index.ts)

## Roles and prompt isolation

A specialist is a seat, not a backend. By default the seat runs locally: the dispatch starts a child agent through `ctx.subagents` with that role's charter prefixed, so the child works under the role's persona and discipline. A seat configured with `mode: a2a` sends the same text to an external agent (a Pi, Claude Code, or OpenCode deployment) whose endpoint the deployment configures; the seat, not the backend, still defines the role. Qiming's charter is the `xingchen-qiming` agent preset's persona, where it replaces the deployment default for that preset only.

The charters are package text (`charters.ts`), overridable per role through `charters`, so a deployment can retune a role's prompt without forking the package.

## Routing

Three paths reach a specialist; all three are logged, and all three feed the projection:

- The `xingchen_route` tool. The router agent calls it when a request clearly belongs to a specialist. The task must be self-contained: the specialist runs in its own environment and cannot see this workspace, so the calling model includes the file contents, diffs, and context the specialist needs.
- The `/review`, `/bug`, and `/planning` commands. A person addresses a specialist directly, with no model turn.
- The exported `routeXingchen` heuristic, which classifies a message without a model: an explicit leading slash command decides, otherwise a role needs two distinct keyword hits and a strictly higher score than every other role. A single weak word never steers a message away from the router, and a message mixing two specialists' signals stays with Qiming, whose job is to decompose it.

## Session metadata

Every dispatch and every turn end appends to the `xingchen` session projection: the last dispatched role, the dispatch count, and how the latest turn ended (`completed`, `aborted` with its cause, `blocked`, `error`, `max-tokens`, or `interrupted`). A turn-end kind this view does not model folds to the generic `error` label, and the full reason stays in the `turn/end` event. The projection is a fold over the session log, so it rebuilds with the session and never needs its own storage.

## Bundled skills

The `./skills` entry registers three skills into the session's catalog: `git` (history, blame, and the commit that introduced a defect), `run` (a reproduction or a focused test with its real result), and `log` (a log or stack trace parsed into the evidence that names a failure). The first two are the grounding 瑶光 needs before attributing a cause; all three are model- and user-invocable, so a person can call `$git`, `$run`, or `$log` from the composer.

## Configuration

No configuration is required: every seat spawns a child agent through `ctx.subagents`.

```yaml
- name: '@reachforstar/dsh-xingchen'
```

To move one seat to a peer or give it its own model:

```yaml
- name: '@reachforstar/dsh-xingchen'
  config:
    seats:
      yaoguang:
        model: amax/qwen-3.8-27B
```

| Field | Default | Meaning |
|---|---|---|
| `seats.<role>.mode` | `local` | `local` delegates to a child agent in this process; `a2a` sends the task to the peer |
| `seats.<role>.provider` | `spawn` | `ctx.subagents` provider used by a `local` seat |
| `seats.<role>.model` | parent's route | Child model route for a `local` seat, as `provider/model` |
| `peers.<role>` | `claude-code` / `pi` / `opencode` | A2A peer used by an `a2a` seat |
| `charters.<role>` | package charter | Replace one role's charter text |

A peer name must exist on the `a2a` row's `peers` map; a name with no configured endpoint fails the dispatch with the peer's own error rather than silently doing nothing.

## Related

- Package reference: [dsh-xingchen](../../packages/xingchen/xingchen/README.md)
- Group overview: [packages/xingchen](../../packages/xingchen/README.md)
- Peer seam: [a2a.md](a2a.md)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxxingchen--xingchenservice"></a>

### `ctx.xingchen` — `XingchenService`

`ctx.xingchen`: the star-domain routing service.

Owns the role bindings (peer + charter), the dispatch with per-session peer-conversation continuity, the `xingchen_route` tool, the `/review` `/bug` `/planning` commands, the routing prompt section, and the `xingchen` projection registration.

```ts cordis-catalog
/**
 * Dispatch one task to a specialist role through its A2A peer, prefixing
 * the role charter and continuing the per-session peer conversation.
 * @param role - the specialist role.
 * @param task - the self-contained task text.
 * @param sessionKey - the session id owning the conversation continuity.
 * @param signal - cancellation owned by the caller.
 * @returns the peer's answer and its continuation addressing.
 */
async dispatch( role: XingchenSpecialistId, task: string, sessionKey: string, signal?: AbortSignal, ): Promise<A2APeerReply>
```

Source: [`packages/xingchen/xingchen/src/index.ts`](../../packages/xingchen/xingchen/src/index.ts)
<!-- END GENERATED cordis-surface -->
