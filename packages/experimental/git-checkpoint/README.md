---
description: "Human-facing /checkpoint command that creates and restores Git checkpoints."
kind: "package-reference"
---

# @deepseek-ai/dsh-git-checkpoint

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-git-checkpoint` to snapshot and restore the session working directory with Git. `/checkpoint` runs `git stash create` and remembers the stash reference; `/checkpoint restore` runs `git stash apply` with that reference, and `/checkpoint clear` forgets it. The command is useful before a risky operation or when moving work between sessions. Mount it in a deployment whose working directory is a Git work tree.

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

Mount the plugin in a composition that provides the shell service, then run the command in an interactive UI.

```yaml
- name: '@deepseek-ai/dsh-git-checkpoint'
  config:
    timeoutMs: 10000
```

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `10000` | Deadline for one git command |

```text
/checkpoint
/checkpoint restore
/checkpoint clear
```

The command requires the session working directory to be inside a Git work tree. A clean worktree produces no checkpoint and reports it.

<a id="understand-the-implementation"></a>
## Understand the implementation

The service executes `git rev-parse --is-inside-work-tree`, `git stash create`, and `git stash apply` through `ctx.shell`, in the session working directory. It keeps the latest stash reference per session in process memory. The command handler validates the sub-command, reports the reference prefix, and surfaces git's stderr on failure.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-shell`](../../shell/shell/README.md) — the command execution service.
- [`dsh-commands`](../../interaction/commands/README.md) — the command registry and execution lifecycle.

<a id="model-experience"></a>
## Model Experience

### Git checkpoint

#### What the model sees

Nothing. The command is a human command: its input and result are recorded by the command lifecycle, and no message enters the conversation. The `git` output never reaches the model.

#### Token effect

Zero. No model request is made.

#### KV Cache effect

None: the conversation is untouched.

## Known Limitations and Deferred Work

- The checkpoint reference lives in process memory; a restart forgets it, although the stash remains in the repository and is visible through `git stash list`.
- No automatic per-turn capture and no automatic restore on fork: the command is explicit.
- Only the latest reference per session is remembered.
- `git stash create` does not write the stash reflog, so a dropped reference is only recoverable through Git's own stash listing.

<a id="dev-note"></a>
### Dev Note

The service deliberately keeps the reference in memory: the durable fact is the stash object Git already holds, and the command is an operator action rather than session history.
