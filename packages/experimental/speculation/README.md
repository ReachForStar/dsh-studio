---
description: "Speculation gate, overlay path planning, and the prediction runner for ahead-of-input execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-speculation

English | [中文](README.zh.md)

## Summary

`dsh-speculation` decides what a speculative run may do before the user submits input, provides the overlay filesystem that keeps those writes out of the workspace, and ships a runner that produces the prediction. Read-only tools run unchanged, file writers are redirected into an overlay path when the policy allows writes, and every other tool stops the run. `OverlayFileSystem` serves reads from overlay copies first, sends every write to the overlay, and exposes `commit` and `discard` so acceptance is the only path into the workspace. The runner module predicts the next request after each completed turn and pre-executes it.

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

A speculation runner calls `gateToolCall` for each predicted call, applies `rewriteArguments` to redirected calls, and stops the run on the first boundary.

### Mount the shipped runner

`@deepseek-ai/dsh-speculation/runner` is a Cordis plugin: after every completed turn it asks one auxiliary route for the most likely next request and the calls that would pre-compute it, gates the plan, and executes it. It requires the `llm`, `tools`, and `fs` services, and reads `workingDirectory` when the policy leaves the root to the Session.

```yaml
- id: speculation
  name: '@deepseek-ai/dsh-speculation/runner'
  config:
    overlayRoot: /work/.speculation
    allowWrites: true
    provider: deepseek
    model: deepseek-chat
```

When the user's next message normalizes to the predicted request and `allowWrites` is set, the runner commits the overlay copies into the workspace; otherwise it discards them. Both outcomes are logged on the Session as `speculation/proposal` and `speculation/outcome`, which never enter the model surface.

### Configuration

- `overlayRoot` — absolute overlay root that receives speculative writes; it must live outside the workspace root in use.
- `workspaceRoot` — optional absolute root that pins every Session to one workspace. Omitted, each Session predicts against its own working directory, so one deployment serves Sessions from any workspace. A Session whose root is missing, relative, or contains `overlayRoot` skips prediction with a warning instead of failing its turn.
- `allowWrites` — whether writers may redirect into the overlay. Defaults to `false`: without an explicit opt-in, no speculative write runs at all, and the runner does not offer write tools to the prediction.
- `readOnlyTools` / `writeTools` — tool classification overrides; empty keeps the built-in sets.
- `pathArgumentKeys` — argument keys carrying a filesystem path; empty keeps `file_path`, `path`, `directory`.
- `provider` / `model` — explicit route for the prediction request; both are required together.
- `maxInputBytes`, `maxOutputTokens`, `timeoutMs` — bounds on one prediction request.
- `maxSteps` — largest number of predicted calls to execute.
- `maxRequestChars` — cap on the predicted request text stored in the log.

## Understand the implementation

`gateToolCall` returns `allow`, `redirect` (with the argument key and overlay path), or `boundary` (with a reason). `overlayPath` maps a model-written path into the overlay only when it stays inside the workspace; escaping paths become boundaries. `gatePlan` applies the same rule to a whole predicted plan and keeps the steps before the first boundary.

The gate is deliberately conservative: writers require `allowWrites`, unknown tools are boundaries, and external-network tools stay in the fixed boundary set regardless of configuration.

`OverlayFileSystem` is a `FileSystem` proxy: it resolves through the base provider, probes `<overlayRoot>/<relative>` before every read, and routes every mutation there. It records each overlay path it produced, so `commit` copies exactly those files back and `discard` removes exactly those files. The same three operations are exported as `seedOverlay`, `commitOverlay`, and `discardOverlay` so a runner that redirects paths instead of proxying the provider shares them.

The runner keeps one run per completed session turn. `executePlan` applies `gatePlan`, rewrites each redirected call's path argument into the overlay, seeds the overlay copy of the workspace file so an edit opens the content the model read, dispatches one call at a time through `ctx.tools.execute` with no Agent, and records each overlay pair it produced. No Agent means a tool that requires approval fails closed instead of prompting during speculation. Overlay copies reach the workspace only through `commitOverlay`.

## Further Exploration

- Ahead-of-input execution in the upstream reference: qwen-code's `followup/speculationToolGate.ts`.
- File provider abstraction a runner would proxy: `@deepseek-ai/dsh-fs`.
- Presentation data produced by sibling packages: `@deepseek-ai/dsh-step-summary`, `@deepseek-ai/dsh-followup`.

## Model Experience

### Speculation gate

#### What the model sees

Nothing. The gate issues no request and logs no event; it only classifies tool calls a speculation runner already produced, returning `allow`, `redirect`, or `boundary` for each `gateToolCall` call.

#### Token effect

Zero tokens: the gate is synchronous local logic over `gateToolCall` arguments.

#### KV Cache effect

None: no model request is affected.

### Speculation runner

#### What the model sees

Nothing during prediction. The runner sends one auxiliary request per completed turn from a message of its own source kind, and the model's own requests never carry the prediction. A later turn sees only the workspace state a commit produced, exactly as if the user had made those edits.

#### Token effect

One short auxiliary request per completed turn, bounded by `maxInputBytes` and `maxOutputTokens`, plus the predicted calls' own execution. The conversation request is unchanged, so its tokens and prompt cache are unaffected.

#### KV Cache effect

None on the conversation: the prediction is a separate `speculation` request on its own message list. A committed write changes the next turn's file content, which is ordinary tool output.

## Known Limitations and Deferred Work

- Predicted reads leave nothing behind: only committed overlay copies survive, so read-only predictions cost tokens without a model-visible result.
- A predicted read sees the workspace file, not an overlay copy an earlier step of the same plan produced.
- No conflict detection on commit: `commit` overwrites the workspace file without comparing the version the overlay copy started from.
- No shell gating: command safety classification is not implemented; shell calls are boundaries.
- No UI: the overlay is an API for a runner, not a user-facing surface.

### Dev Note

The gate is pure so that a runner can test its safety policy without executing anything; the runner keeps its execution and settlement steps separate so each is testable without a model.
