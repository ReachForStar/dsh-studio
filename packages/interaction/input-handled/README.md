---
description: "Intercept user input before it enters the model."
kind: "package-reference"
---

# @deepseek-ai/dsh-input-handled

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-input-handled` to let an extension intercept a user's input before it enters the model. An interceptor may return `continue`, `transform` with replacement text, or `handled` so the input is processed in place and never appended to the conversation. The service is consulted by the session prompt path; mount it together with an extension that registers an interceptor.

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

Mount the plugin, then register an interceptor from an extension.

```yaml
- name: '@deepseek-ai/dsh-input-handled'
```

```ts ignore-check
ctx.inputHandling.register({
  intercept: (agent, text, signal) => {
    if (text === 'ping') return { action: 'handled' }
    if (text.startsWith('?quick ')) return { action: 'transform', text: `Answer briefly: ${text.slice(7)}` }
    return { action: 'continue' }
  },
})
```

Interceptors run in registration order; the first non-`continue` decision wins. A `handled` input is acknowledged without creating a conversation message. A `transform` decision replaces the submitted text. Interceptors without a provider composition are skipped.

<a id="understand-the-implementation"></a>
## Understand the implementation

The service keeps an ordered list of interceptors and awaits each until one returns a decision other than `continue`. The session prompt controller extracts the submitted text, calls the service when it is mounted, and applies the decision before attachment admission: `handled` returns acceptance without enqueuing, and `transform` replaces the text parts.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-commands`](../commands/README.md) — human commands that never enter the model, a sibling mechanism.
- [`dsh-session-controller`](../../api/session-controller/README.md) — the prompt path that consults the service.

<a id="model-experience"></a>
## Model Experience

### Input handling

#### What the model sees

Only the decision's result: a `continue` input arrives unchanged, a `transform` input arrives with its replacement text, and a `handled` input never arrives. The interceptor source and any other input never enter the request.

#### Token effect

`handled` removes the input from the conversation entirely; `transform` changes the submitted text to the replacement, so the request carries the replacement instead of the raw input.

#### KV Cache effect

The request prefix follows the effective text exactly as an ordinary submission: unchanged for `continue`, rewritten for `transform`, and unchanged for a dropped `handled` input.

## Known Limitations and Deferred Work

- Only text parts are intercepted; image and file parts pass through, and a `transform` decision replaces the whole submission with one text part.
- The prompt controller passes a fresh `AbortSignal` per submission because the request carries none.
- A `handled` input produces no durable record beyond the controller's ordinary acknowledgement; it is not logged as a message.

<a id="dev-note"></a>
### Dev Note

The decision vocabulary mirrors the command surface: `continue`, `transform`, and `handled` keep the input path single while letting an extension own an input the model never sees.
