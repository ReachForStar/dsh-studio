---
description: "Virtual model routing that resolves a selected model to a physical model per request."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-virtual-model

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-agent-virtual-model` to register a selectable virtual model that routes each request to a physical provider/model. The user's selection stays recorded as the virtual route; each request header records the physical model that answered. A router may return state, which is persisted as a log-only event and folded per session branch. Mount it when a deployment wants one selectable route that splits work across models by task, cost, or conversation phase.

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

Mount the plugin in a composition that provides session projections, then register a virtual model.

```yaml
- name: '@deepseek-ai/dsh-agent-virtual-model'
```

```ts ignore-check
ctx.virtualModels.register({
  provider: 'router',
  id: 'auto',
  name: 'Auto',
  route: (request) => {
    const sticky = request.reason === 'retry' ? request.failed : request.previous
    if (request.reason !== 'user' && sticky) return { selection: sticky }
    return { selection: { provider: 'deepseek', model: 'deepseek-chat' } }
  },
})
```

Selecting `router/auto` through the ordinary model picker records that route; every request resolves through `route()`. The request carries `reason` (`user`, `continuation`, `retry`, `direct`), the last successful physical selection, the failed selection on a retry, the stored state, and the request messages.

The router returns a physical `selection` and may return a new `state`. Returning `undefined` or the received state keeps the stored state.

<a id="understand-the-implementation"></a>
## Understand the implementation

The service keeps a registry keyed by `provider/id`. On each request, `AgentModel` asks its injected resolver; an unregistered selection passes through unchanged. A registered selection invokes the router with the request context and persists a returned state through the log-only `virtual-model/state` event. The `virtualModelState` projection folds those events, so resume and fork inheritance restore the branch's state.

Tool resolution and the system prompt use the resolved physical selection, while the model picker and the model-switch notice keep using the recorded virtual selection.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-agent`](../agent/README.md) — the model selection and route resolver contracts.
- [`dsh-session-projection`](../../session/session-projection/README.md) — the projection registry that stores router state.

<a id="model-experience"></a>
## Model Experience

### Virtual model routing

#### What the model sees

The `provider` and `model` that the router selected for this request, exactly as if the user had selected it directly. The virtual route name, the router function, and the stored router state never enter the request.

#### Token effect

Unchanged from an ordinary model request: routing selects one physical model per request and adds no prompt sections or tool schemas.

#### KV Cache effect

Routing changes the physical model per request, so the cache key follows the selected physical model exactly as a manual model switch would; a sticky router that keeps the previous physical model preserves the prefix.

## Known Limitations and Deferred Work

- The built-in loop reports `user` for the first step of a turn and `continuation` otherwise; it does not yet distinguish a retry with a failed selection.
- Router state is per session branch and is not shared across sessions.
- The virtual route is not listed in client model pickers; a client must add it explicitly.
- A router that throws fails the request; no fallback to the recorded selection is implemented.

<a id="dev-note"></a>
### Dev Note

The resolver is injected into `AgentModel` only when the service is mounted, so compositions without it keep the previous synchronous behavior.
