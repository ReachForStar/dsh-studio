---
description: "Speculation gate and overlay path planning for ahead-of-input execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-speculation

English | [中文](README.zh.md)

## Summary

`dsh-speculation` decides what a speculative run may do before the user submits input. Read-only tools run unchanged, file writers are redirected into an overlay path when the policy allows writes, and every other tool stops the run. The module is pure logic: it classifies one call or a whole plan and returns the path rewrite a runner must apply. It never touches the filesystem, so a runner owns overlay creation, execution, and commit.

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

## Further Exploration

- Ahead-of-input execution in the upstream reference: qwen-code's `followup/speculationToolGate.ts`.
- File provider abstraction a runner would proxy: `@deepseek-ai/dsh-fs`.
- Presentation data produced by sibling packages: `@deepseek-ai/dsh-step-summary`, `@deepseek-ai/dsh-followup`.

## Model Experience

### Speculation gate

#### What the model sees

Nothing. This package issues no request and logs no event; it only classifies tool calls a speculation runner already produced, returning `allow`, `redirect`, or `boundary` for each `gateToolCall` call.

#### Token effect

Zero tokens: the gate is synchronous local logic over `gateToolCall` arguments.

#### KV Cache effect

None: no model request is affected.

## Known Limitations and Deferred Work

- No overlay filesystem: this package plans paths; a proxy `FileSystem` implementation that serves reads from the overlay and commits on acceptance is deferred.
- No prediction: generating the speculative plan from user intent belongs to a runner.
- No commit step: moving overlay content into the workspace is the runner's responsibility.
- No shell gating: command safety classification is not implemented; shell calls are boundaries.

### Dev Note

The gate is pure so that a runner can test its safety policy without executing anything.
