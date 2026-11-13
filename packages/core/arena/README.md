---
description: "Compare models on one prompt in isolated worktrees and apply the chosen result."
kind: "package-reference"
---

# @deepseek-ai/dsh-arena

English | [中文](README.zh.md)

## Summary

`dsh-arena` runs one prompt through several models at once, each in its own Git worktree branched from the same commit, and returns comparable results: reply text, status, duration, turns, tool calls, tokens, and changed paths. `ctx.arena.run()` never touches the main checkout. `ctx.arena.apply()` applies one contender's diff afterwards, and `ctx.arena.remove()` deletes the checkouts. Use it when a deployment must compare models on real work instead of on a fixed prompt.

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

Mount the service beside `agents`, `fs`, `subprocess`, `sandbox`, and `sandboxPolicy`:

```yaml
- id: arena
  name: '@deepseek-ai/dsh-arena'
  config:
    workspaceRoot: /work/repo
    worktreeRoot: /work/.arena
```

`ctx.arena.run({ prompt, contenders })` resolves after every contender reaches quiescence and returns one `ArenaRun` with a result per contender. `ctx.arena.runs()` lists the runs the service still retains, `ctx.arena.apply(runId, label)` writes one contender's diff into `workspaceRoot`, and `ctx.arena.remove(runId)` deletes the run's checkouts and branches. Each contender names a `label`, a `provider`, a `model`, and an optional `maxTokens`.

### Configuration

- `workspaceRoot` — absolute repository checkout the run reads `HEAD` from and applies winners to.
- `worktreeRoot` — absolute directory holding one subdirectory per run; it must live outside `workspaceRoot`.
- `maxContenders` — largest accepted contender count in one run. Defaults to 4.
- `timeoutMs` — deadline for one git command. Defaults to 60000.
- `graceMs` — termination grace period for one git command. Defaults to 3000.
- `maxOutputBytes` — maximum captured bytes per git output stream. Defaults to 1048576.

## Understand the implementation

`run()` resolves the request, reads the base commit with `git rev-parse`, creates one branch and checkout per contender with `git worktree add -b`, and starts one ordinary Session per contender whose `SessionHeader.cwd` is that checkout. Each Session receives the prompt as a `dsh-arena` user message and runs a complete turn, so the comparison measures the models and not their ability to share a tree.

Comparison data accumulates from delivered `session/event` messages: `turn/start`, `tool/call`, and `assistant/message` supply turns, tool calls, the reply, and adapter-reported usage. No historical read is involved, and events from Sessions the run does not own are ignored.

Diff collection stages the checkout with `git add --all` before reading `git diff --cached <base>`, so a model that never commits still yields a complete change set, new files included. `apply()` writes that diff to a patch file inside the run directory and applies it to `workspaceRoot`; `remove()` deletes the checkouts and branches with `git worktree remove --force` and `git branch -D`.

Every git command runs through `subprocess` and `sandbox` with the deployment policy resolved by `sandboxPolicy`, and strips the repository selectors that would otherwise retarget a nested invocation.

## Further Exploration

- Isolated checkouts for a single Session: `@deepseek-ai/dsh-experimental-worktree`.
- Delegated child Agents: `@deepseek-ai/dsh-subagent`.
- Upstream comparison feature this replaces: qwen-code's `agents/arena/ArenaManager.ts`.

## Model Experience

### Arena contenders

#### What the model sees

Each contender sees the same prompt text as a `dsh-arena` user message in its own Session, plus the tools its composition mounts. No contender sees another contender's output, and nothing about the comparison enters a request.

#### Token effect

Every contender runs a complete turn, so a comparison costs the sum of its contenders' requests. Replies are collected for the caller and are not sent to another model.

#### KV Cache effect

None across contenders: each runs a separate Session with its own prefix. Repeating a run reuses nothing from the previous one's cache.

## Known Limitations and Deferred Work

- No UI or tool: the service is a programmatic API; a comparison view is not implemented.
- No structured summary of *how* the contenders differ: only replies and changed paths are compared.
- Applying a diff does not run tests, ask for approval, or detect conflicts with changes made after the run started.
- A run keeps its checkouts until `remove()`; a deployment that never removes them accumulates directories.
- Contender Sessions are disposed after settlement, so only their persisted logs remain.

### Dev Note

Git work runs through injected capabilities so the deployment policy, not the package, decides how much the comparison may write.
