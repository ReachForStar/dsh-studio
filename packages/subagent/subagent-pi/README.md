# @deepseek-ai/dsh-subagent-pi

English | [中文](README.zh.md)

This package registers the fixed `pi` subagent provider. Each accepted run starts the [Pi coding agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) in its RPC mode in the delegating Session's workspace, submits one self-contained text task over the Pi line-delimited JSON stdio protocol, and returns only the final answer through the shared [`dsh-subagent`](../subagent/README.md) result contract.

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks and derives the child cwd from the parent Session. It then spawns the fixed `pi --mode rpc` command through [`dsh-subprocess`](../../subprocess/subprocess/README.md) and publishes the run only after the RPC server answered a `get_state` readiness probe. A failure or cancellation before publication closes the wire, terminates the managed process tree, waits for it to exit, and rejects `start()`.

The published `run.result` starts exactly one turn. It sends a `prompt` command, waits for the streamed `agent_settled` event, then reads the terminal answer with `get_last_assistant_text` — the last non-empty assistant text. Pi's RPC responses carry no committed partial-output projection, so cancellation and failure settle with an empty output snapshot. A settled run without an answer, a `prompt` response with `success: false`, a protocol failure, or a process failure all map to `error`; the provider produces neither `max-tokens` nor `refusal`.

Extension UI dialogs (`select`, `confirm`, `input`, `editor`) are auto-answered with `cancelled`, so unattended runs do not wait on a user interface this provider does not own; the remaining extension UI requests (`notify`, `setStatus`, …) are ignored. Local cancellation wins the result race and maps to `aborted`. `dispose()` is idempotent: it closes the wire, asks Pi to shut down cooperatively through stdin EOF, escalates to the shared process-tree termination after `disposeEofGraceMs`, and waits for whole-tree exit. Result failure and independent teardown failure remain separate.

## Capabilities and context

The provider advertises no optional start-time capabilities and reports `inheritsParentContext: false`. Pi receives the standalone text task and the parent Session cwd, but not the parent conversation, persona, tool filter, depth policy, or structured-output contract. Every run has an independent RPC process, session file, and cancellation controller.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `env` | `{}` | Explicit child environment layered over the subprocess seam's credential-scrubbed parent environment. Pi credentials (for example `DEEPSEEK_API_KEY`) and any Pi extension variables belong here. |
| `disposeEofGraceMs` | `6000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md), between Pi's stdin-EOF shutdown request and the shared process-tree termination escalation. |
| `disposeGraceMs` | `3000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md), between the shared process-tree owner's termination tiers. |
| `command` | `pi` | Pi executable (bare name on `PATH`) or a test fixture launcher. On Windows the argv is wrapped in `cmd.exe /d /s /c` because npm and pnpm installs expose `pi.cmd`. |
| `args` | `['--mode', 'rpc']` | Fixed arguments appended after the executable; the array replaces the default, so an override must restate `--mode rpc`. A deployment may pin Pi's model here, for example `['--mode', 'rpc', '--provider', 'deepseek']`. |
| `agentDir` | unset | Absolute `PI_CODING_AGENT_DIR` override naming where Pi keeps agent settings and trust state; when omitted, Pi uses its native home (`~/.pi/agent`). Wins over an `env.PI_CODING_AGENT_DIR` entry. |
| `sessionDir` | unset | Absolute `PI_CODING_AGENT_SESSION_DIR` override naming where Pi keeps session files; when omitted, Pi uses its native session location. Wins over an `env.PI_CODING_AGENT_SESSION_DIR` entry. |

Production resolves `pi` from the subprocess execution world's credential-scrubbed `PATH`. Native Pi settings and authentication remain authoritative: the plugin does not install Pi, select a model, create a Pi home, log in, or probe a version. Credential-shaped ambient variables are removed before the explicit `env` overlay is applied, so an API key or token intended for the child must be supplied there.

Shipped profiles load this provider once on the host and start no Pi process until a tool call. Full Agent Presets carry the tool row below with `disabled: true`; copy a preset and remove that field to expose `subagent_pi` only to agents composed from the copy. A custom host composition can still use both rows directly.

```yaml
- id: subagent-pi
  name: '@deepseek-ai/dsh-subagent-pi'
  config:
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY

- id: tool-subagent-pi
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: pi
    toolName: subagent_pi
    enableRunInBackground: false
    maxDepth: provider-managed
```

## Product compatibility and evidence

The runtime dependency is pinned to `@earendil-works/pi-coding-agent@0.84.2`. Production runs the native `pi` installation. The keyless real-product test uses the pinned npm CLI as a deterministic fixture, routed through the same native executable-resolution and Windows batch-shim path; it does not claim compatibility with every independently installed version. The RPC wire implements only the commands this one-shot contract needs (`get_state`, `prompt`, `get_last_assistant_text`, `abort`); upgrading Pi requires regenerating protocol evidence and rerunning handshake, answer, cancellation, and disposal tests. Loader composition proves that both product packages coexist without starting either product.

## Model Experience

### Child request

#### What the model sees

The Pi child receives the standalone text task as one fresh RPC prompt in a new session. Its workspace is the parent Session cwd, while its model, system instructions, tools, and authentication come from the native Pi installation and configuration (`args` may pin a provider).

#### Token effect

The child pays for an independent Pi context and turn. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on Pi's own provider, model, instructions, tools, and fresh session.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent sees only the strict final Pi answer or the consumer's exact error for a non-completed result. Pi reasoning, tool activity, intermediate messages, stderr, workspace diffs, and product ids are not copied into the parent Session.

#### Token effect

Parent input grows only by the final answer or error retained in the tool result. This provider adds no parent tool schema by itself.

#### KV Cache effect

Append-only: the new tool result follows the reusable parent request prefix.

## Known Limitations and Deferred Work

- **One fresh RPC process, session, and turn per run** — there is no continuation, resume, pooling, progress stream, or product-session persistence.
- **Host-managed product installation and account state** — a missing or incompatible `pi`, configuration error, or authentication failure is surfaced as a startup or run error; the plugin provides no installer, login flow, or runtime version gate.
- **Model selection stays with the host Pi configuration** — the default `args` select no provider; a deployment pins `--provider`/`--model` through `args` when it must.
- **Compatibility is pinned by development evidence** — upgrading from the verified 0.84.2 protocol baseline requires regenerating upstream schema evidence and rerunning handshake, answer-selection, cancellation, keyless real-product, and credentialed DeepSeek nonce tests.
- **No human interaction path** — extension UI dialogs are auto-cancelled and other interactive flows are absent, so tasks requiring new approval or input fail instead of suspending.
- **Final text only** — reasoning, intermediate messages, tool traffic, usage, stderr, and workspace diffs remain product-local; cancellation and failure carry no partial output because Pi's RPC protocol exposes no committed partial projection.
- **No optional shared capabilities** — output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider.
- **No wall-clock timeout or side-effect rollback** — the caller cancels long work, and files or external systems changed before cancellation are not restored.
