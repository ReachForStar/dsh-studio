---
description: "Speculation gate and overlay path planning for ahead-of-input execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-speculation

English | [中文](README.zh.md)

## Summary

`dsh-speculation` decides what a speculative run may do before the user submits input, and provides the overlay filesystem that keeps those writes out of the workspace. Read-only tools run unchanged, file writers are redirected into an overlay path when the policy allows writes, and every other tool stops the run. `OverlayFileSystem` serves reads from overlay copies first, sends every write to the overlay, and exposes `commit` and `discard` so acceptance is the only path into the workspace.

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

### Configuration

- `workspaceRoot` — absolute workspace root the overlay mirrors.
- `overlayRoot` — absolute overlay root that receives speculative writes.
- `allowWrites` — whether writers may redirect into the overlay. Defaults to `false`: without an explicit opt-in, no speculative write runs at all.
- `readOnlyTools` / `writeTools` — tool classification overrides; empty keeps the built-in sets.
- `pathArgumentKeys` — argument keys carrying a filesystem path; empty keeps `file_path`, `path`, `directory`.

## Understand the implementation

`gateToolCall` returns `allow`, `redirect` (with the argument key and overlay path), or `boundary` (with a reason). `overlayPath` maps a model-written path into the overlay only when it stays inside the workspace; escaping paths become boundaries. `gatePlan` applies the same rule to a whole predicted plan and keeps the steps before the first boundary.

The gate is deliberately conservative: writers require `allowWrites`, unknown tools are boundaries, and external-network tools stay in the fixed boundary set regardless of configuration.

`OverlayFileSystem` is a `FileSystem` proxy: it resolves through the base provider, probes `<overlayRoot>/<relative>` before every read, and routes every mutation there. It records each overlay path it produced, so `commit` copies exactly those files back and `discard` removes exactly those files.

## Further Exploration

- Ahead-of-input execution in the upstream reference: qwen-code's `followup/speculationToolGate.ts`.
- File provider abstraction a runner would proxy: `@deepseek-ai/dsh-fs`.
- Presentation data produced by sibling packages: `@deepseek-ai/dsh-step-summary`, `@deepseek-ai/dsh-followup`.

## Model Experience

### Speculation gate

#### What the model sees

Nothing. This package issues no request and logs no event; it only classifies tool calls a speculation runner already produced, returning `allow`, `redirect`, or `boundary` for each `gateToolCall` call, and serves `OverlayFileSystem` reads and writes.

#### Token effect

Zero tokens: the gate is synchronous local logic over `gateToolCall` arguments.

#### KV Cache effect

None: no model request is affected.

## Known Limitations and Deferred Work

- No prediction: generating the speculative plan from user intent belongs to a runner.
- No conflict detection on commit: `commit` overwrites the workspace file without comparing the version the overlay copy started from.
- No shell gating: command safety classification is not implemented; shell calls are boundaries.
- No UI: the overlay is an API for a runner, not a user-facing surface.

### Dev Note

The gate is pure so that a runner can test its safety policy without executing anything.
