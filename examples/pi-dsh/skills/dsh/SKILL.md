---
name: dsh
description: Delegate a subtask to a DeepSeek Harness agent runtime and read its final answer. Use when a task is better handled by a DeepSeek Harness agent (its own model route, tools, session persistence) than by this agent, or when the user asks to collaborate with DeepSeek Harness.
---

# DeepSeek Harness delegation

You can delegate a self-contained subtask to a DeepSeek Harness JSON-RPC agent runtime and receive its final answer. The delegate helper spawns the runtime, submits one prompt, prints only the final assistant text, and shuts the runtime down.

## When to delegate

Delegate when the subtask is self-contained and benefits from a separate agent context: a long analysis, a coding task in a different workspace, or work the user explicitly wants a DeepSeek Harness agent to perform. Keep the subtask description self-contained: the child agent sees only your task text and its own configured system prompt, tools, and working directory — not this conversation.

## How to delegate

Run the helper with the child runtime's configuration and the task text:

```sh
node dsh-delegate.mjs <path/to/child-cordis.yml> "<self-contained task>"
```

The helper resolves the `dsh-jsonrpc-agent` runtime from `PATH` (or `DSH_DELEGATE_COMMAND`). Use the provided child composition as the configuration when one is available, or the repository reference composition `examples/jsonrpc-agent/cordis.yml`.

Environment overrides (all optional):

| Variable | Meaning |
|---|---|
| `DSH_DELEGATE_COMMAND` | Runtime executable; default `dsh-jsonrpc-agent`. |
| `DSH_DELEGATE_ARGS` | JSON array of extra args before the config path. |
| `DSH_DELEGATE_CWD` | Child agent workspace; default the process working directory. |
| `DSH_DELEGATE_PROVIDER` | Provider route for the child; default `deepseek-official`. |
| `DSH_DELEGATE_MODEL` | Model for the child; default `deepseek-v4-flash`. |

## Output contract

The helper prints exactly one line to stdout: the child agent's final answer (its last non-empty assistant text). Treat that line as the delegation result. A non-zero exit code or a `dsh-delegate failed:` line on stderr means the delegation failed; report the error rather than guessing.

## Examples

```sh
node dsh-delegate.mjs ./child-cordis.yml "Summarize the changes in src/ since the last commit."
DSH_DELEGATE_MODEL=deepseek-v4-pro node dsh-delegate.mjs ./child-cordis.yml "Draft an ADR for the queue redesign."
```
