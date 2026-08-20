# Agent Note: Pi subagent backend

Status: implemented

English | [中文](2026-08-15-pi-subagent-backend.zh.md)

## Problem

The subagent seam supports out-of-process delegation to Claude Code and Codex, but not to [Pi](https://github.com/earendil-works/pi), the open-source coding agent from the same toolkit as the `@earendil-works/pi-ai` library this repo already vendors through `dsh-llm-pi-ai`. A dsh agent could not delegate a task to a Pi child, and bidirectional collaboration with Pi lacked the dsh-to-Pi half.

## Decision

`@deepseek-ai/dsh-subagent-pi` registers the fixed `pi` provider on `ctx.subagents`. Each accepted run spawns `pi --mode rpc` in the delegating Session's workspace through the subprocess seam, proves readiness with one `get_state` command, submits one text task with `prompt`, waits for the streamed `agent_settled` event, and reads the terminal answer with `get_last_assistant_text` — the last non-empty assistant text. Extension UI dialogs are auto-answered with `cancelled` so unattended runs do not suspend on a UI this provider does not own. Disposal closes the wire, requests Pi's cooperative EOF shutdown, waits `disposeEofGraceMs`, then escalates through the shared process-tree termination ladder. The provider advertises no start-time capabilities and reports `inheritsParentContext: false`.

The wire contract is pinned to `@earendil-works/pi-coding-agent@0.84.2` (RPC commands `get_state`, `prompt`, `get_last_assistant_text`, `abort`; responses `{ id, type: "response", command, success, data | error }`; the `agent_settled` event). Stop-reason mapping: non-empty answer → `completed`; settled-without-answer, failed `prompt`, protocol or process failure → `error`; local cancellation → `aborted`. Pi produces neither `max-tokens` nor `refusal` through this provider, and cancellation and failure settle with an empty output snapshot because Pi's RPC protocol exposes no committed partial-output projection.

`PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are configurable as absolute `agentDir`/`sessionDir` overrides so a deployment redirects Pi's agent and session state out of the user's native home; model selection stays with Pi's native configuration, and a deployment may pin a provider through the `args` override. The keyless real-product test drives the pinned npm CLI as a deterministic fixture; the credentialed e2e delegates a nonce through the pi-ai `deepseek` provider.

This is the dsh-to-Pi direction of the bidirectional Pi collaboration. The Pi-to-dsh direction is a Pi Agent Skill driving a dsh JSON-RPC agent bin (`dsh-jsonrpc-agent`), shipped as the `pi-dsh` example, so both products can delegate to each other.

## Alternatives considered

### Print mode instead of RPC mode

`pi -p "task"` exists and is simpler, but it offers no session readiness handshake, no cancellation verb, and no terminal-answer query; the provider would parse free stdout. RPC mode provides `get_state` readiness, `abort`, and `get_last_assistant_text` as protocol contracts, and mirrors the Codex app-server backend's shape.

### Driving Pi through the third-party ACP adapter

`pi-acp` adds Agent Client Protocol support to Pi, which would let the existing `subagent-acp` provider drive Pi with no new code. It is a third-party adapter with its own versioning and compatibility surface, and it cannot serve the readiness/answer/cancellation contracts this provider owns. The fixed `pi --mode rpc` interface is the product's native embedding surface.

### Building `dsh-mcp-server` first and connecting Pi over MCP

Pi's MCP client support was still an open issue when this shipped, and the repo had no MCP server capability. A server would benefit every MCP host, but the subagent provider is the smaller, repo-native path that satisfies the delegation contract today; MCP server work remains a separate decision with its own note.

## Consequences

- One-shot only: every run is a fresh Pi RPC process, session file, and turn; there is no continuation, resume, pooling, or progress stream, matching the other external-CLI providers.
- Host-managed product state: Pi installation, authentication, and model selection remain native; the plugin provides no installer, login flow, or version gate, and credentials must be supplied through the explicit `env` overlay after the subprocess seam's scrub.
- Protocol-pinning burden: upgrading Pi requires regenerating wire evidence and rerunning handshake, answer, cancellation, keyless real-product, and credentialed nonce tests, exactly like the Codex backend's pinned baseline.
- The provider contributes no new durable events or model-visible input beyond the shared subagent tool result contract, so the session-log invariant is unaffected.
