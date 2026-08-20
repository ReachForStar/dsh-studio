# Bidirectional Pi ↔ DeepSeek Harness collaboration

English | [中文](README.zh.md)

This example wires the two coding agents together so each can delegate work to the other.

| Direction | Mechanism | Where |
|---|---|---|
| dsh → Pi | The `pi` subagent provider starts `pi --mode rpc` and delegates one task | [`@deepseek-ai/dsh-subagent-pi`](../../packages/subagent/subagent-pi/README.md) |
| Pi → dsh | A Pi Agent Skill runs `dsh-delegate.mjs`, which starts a dsh JSON-RPC agent runtime and returns its final answer | `skills/dsh/SKILL.md` + `bin/dsh-delegate.mjs` |

## dsh delegates to Pi

Compose the opt-in provider and expose the `subagent_pi` tool (see the provider README for the exact rows). The dsh agent then calls the tool with a self-contained task; Pi runs in the parent session's workspace and returns only its final answer.

## Pi delegates to dsh

Install the Agent Skill into Pi's skill directory (`.pi/skills/dsh/SKILL.md`), copy `bin/dsh-delegate.mjs` beside it (or place `dsh-jsonrpc-agent` on `PATH`), and provide the child runtime's `cordis.yml`. The repository reference child composition is [`../jsonrpc-agent/cordis.yml`](../jsonrpc-agent/cordis.yml) — a full unattended dsh runtime speaking stdio JSON-RPC. Pi then runs:

```sh
node dsh-delegate.mjs <path/to/cordis.yml> "<self-contained task>"
```

The helper prints the child agent's final answer on stdout and shuts the runtime down. The skill documents the overrides (`DSH_DELEGATE_COMMAND`, `DSH_DELEGATE_ARGS`, `DSH_DELEGATE_CWD`, `DSH_DELEGATE_PROVIDER`, `DSH_DELEGATE_MODEL`).

## Keyless verification

`tests/delegation.e2e.ts` runs the delegate helper against a scripted child runtime (`child.cordis.yml`, whose model echoes its process cwd) and asserts the exact answer, so the exact flow the skill documents is proven end to end without an API key. The dsh → Pi direction is verified by the provider's own loader-composition, keyless real-product, and credentialed e2e suites.
