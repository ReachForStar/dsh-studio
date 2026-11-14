---
description: "Persistent project and user memory notes for agents: MEMORY.md baseline context kept current across file edits."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-notes

English | [中文](README.zh.md)

## Summary

`dsh-memory-notes` gives agents durable recollection from `MEMORY.md` files: a user-global note under `<dsh home>/memory`, then a project note at the nearest directory holding a configured root marker. Both load into the first request as one bounded note message and stay current by re-reading on every pre-step, so edits made by earlier tool calls are visible to later steps; a file that disappears removes its block. A shared character budget bounds the complete note, truncating the excess with a marker, and a non-positive budget disables injection.

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

Add `/MEMORY.md` to a project (or `<dsh home>/memory/MEMORY.md` for personal notes) and mount this plugin; the note enters every step's model-visible surface before the claimed prompt.

### What the agent gets

The memory note lands as a `user/message` with an attribution-only `memory-notes` source, placed after the claimed batch so the direct prompt precedes it. User notes load before project notes under one `maxChars` budget; each file is labeled with its layer and display path. A restated note — same content, same source — is a no-op; a changed note replaces the previous one; a deleted note removes its block from the next decision.

### Writing notes

When `tools` and `fs` are composed, the package also registers `memory_write`. It appends one bullet to the selected `MEMORY.md` — the nearest project root for `project`, `<dsh home>/memory` for `user` — and returns the saved path. Writes serialize per file, so concurrent calls cannot interleave. Text that looks like a credential, exceeds `maxWriteChars`, or is empty is rejected without touching the file. The note does not enter the current session; the next pre-step re-reads the file like any other edit.

### Configuration

- `memoryFileNames` — candidate basenames in priority order; the first existing file wins per layer. Defaults to `MEMORY.md`.
- `projectRootMarkers` — directory entries that identify the project root while walking upward. Defaults to `.git`.
- `maxChars` — total text cap for the complete note; larger notes are truncated with a marker, non-positive disables injection. Defaults to `20000`.
- `maxWriteChars` — character cap for one `memory_write` note. Defaults to `4000`.
- `writeTool` — register `memory_write` when `tools` and `fs` are composed. Defaults to `true`.

`dsh-base` does not enable this plugin: memory notes are an opt-in context source, mounted by profiles or hosts that want durable recollection without a dedicated memory service.

## Understand the implementation

`apply` registers a single `agent/pre-step` listener that delegates to `applyPreStepMemory`: it resolves the working directory, walks upward to the project root, probes the user memory directory and the project root for candidate files, reads them under the shared budget, and folds the resulting note after the claimed batch. All reads go through the caller-scoped `ctx.fs` provider, so sandbox policy applies unchanged, and every file access is abort-aware.

The projection has no retained session state: injection is derived from the files at each pre-step, so the note is always current and the session log rebuilds it exactly from its `memory-notes` source.

## Further Exploration

- The `agent/pre-step` waterfall contract: `packages/core/agent/src/runtime-types.ts`.
- Attribution-only source kinds: the `@persistenceAttribution` convention in `dsh-llm`'s `MessageSourceMap`.
- Bounded instruction loading with the same provider style: `@deepseek-ai/dsh-agent-instructions`.

## Model Experience

### Memory note

#### What the model sees

If a memory file exists, each step's message batch carries one `user` message titled by layer and path — `--- BEGIN PROJECT MEMORY (MEMORY.md) ---` — with the note text and a closing marker, prefixed by a short instruction to prefer these recorded facts over speculation. Layers render in user-then-project order inside one message.

#### Token effect

The note text is counted exactly as its `user/message` content; the attribution-only source adds no serialized tokens beyond the message envelope. Reading and probing work against the fs budget, not the model budget: token cost rises only with the characters actually injected, up to `maxChars`.

#### KV Cache effect

The note enters through the standard user-message path, so KV-cache behavior follows the base conversation: no additional context blocks are created beyond the one note message.

### Memory write tool

#### What the model sees

`memory_write` returns the saved layer and path, or a validation error naming the rejected scope, empty text, over-budget text, or credential-like content. The stored bullet is not echoed in the tool result; the next pre-step injects the updated note through the normal memory message.

#### Token effect

The tool call carries only the scope and note text. Its result is one short confirmation or validation sentence, so token cost is bounded by the caller's text plus that sentence; the stored note is not repeated in the result.

#### KV Cache effect

The call and result use the ordinary tool-call and tool-result messages, so KV-cache behavior follows the base conversation. The changed memory note reaches the model as a new `user/message` at the next pre-step, exactly like any other memory edit.

## Known Limitations and Deferred Work

- No background extraction: notes are written explicitly through `memory_write` or by other tools; automatic extraction from completed turns is a future memory service.
- No per-note budgets: one shared `maxChars` bounds the complete note; files beyond the budget are truncated, not individually sized.
- No watched files: freshness comes from per-pre-step reads, which is cheap for small notes but rereads on every step.
- No deletion of stale user notes: removal is a file-system operation, not a plugin policy.

### Dev Note

The package follows the context-package conventions: zero retained session state, provider reads through `ctx.fs`, and a pure exported `applyPreStepMemory` that the `agent/pre-step` listener delegates to, which keeps the waterfall wiring thin and the core logic directly testable.