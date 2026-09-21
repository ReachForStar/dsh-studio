# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

**This repository is a customized fork** of the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it tracks the official release as its base and layers the star-domain multi-agent routing, the A2A gateways and their local stack, the Web GUI polish, the model-facing whiteboard tools, and the Pi backends described in the next section on top. Everything stays a Cordis plugin, so the additions mount by composition and the official core remains intact.

## Customizations over the official release

### Star-domain multi-agent (启明 + 天权 / 瑶光 / 天梁)

| Package | What this fork adds |
|---|---|
| [`@deepseek-ai/dsh-xingchen`](packages/xingchen/xingchen/README.md) | 启明 (Qiming) routes a session to three specialist seats — 天权 (architecture and code review), 瑶光 (bug reproduction), 天梁 (delivery planning) — through `/review`, `/bug` and `/planning`, as delegated child agents or over A2A peers; the seats' answers enter the transcript as assistant-role messages. See [star-domain routing](docs/subsystems/xingchen.md). |
| [`@deepseek-ai/dsh-a2a`](packages/a2a/a2a/README.md) | The A2A client: protocol types, direct HTTP dispatch, and the Kafka bus channel that carries tasks and replays events. |
| [`@deepseek-ai/dsh-a2a-host`](packages/a2a/a2a-host/README.md) | The A2A host endpoint this deployment publishes for inbound peers. |
| [`@deepseek-ai/dsh-tool-a2a`](packages/a2a/tool-a2a/README.md) | Model-facing peer tools (`a2a_peers`, `a2a_send`) for conversational dispatch. |
| [`deploy/a2a/`](deploy/a2a/README.md) | The local stack: a 3-broker Kafka cluster, the three A2A gateways vendored into this repository, and the Web app, started by one command with skip-if-running semantics. |

### Pi backends

| Package | What this fork adds |
|---|---|
| [`@deepseek-ai/dsh-pi-agent-loop`](packages/core/pi-agent-loop/README.md) | The Pi coding agent as a second session backend beside the native loop, selected per session. |
| [`@deepseek-ai/dsh-subagent-pi`](packages/subagent/subagent-pi/README.md) | A subagent provider that delegates a task to the [Pi coding agent](https://github.com/earendil-works/pi) over its RPC mode. |
| [`@deepseek-ai/dsh-llm-pi-ai`](packages/llm/llm-pi-ai/README.md) | The provider routing and model-catalog resolution the Pi backends use. |

### Web GUI, workspace, and tools

| Package | What this fork adds |
|---|---|
| [`@deepseek-ai/dsh-client-ui-polish`](packages/client/ui-polish/README.md) | Web GUI polish: a whole-app background image (10MB upload cap, structural surfaces turned transparent behind it), a session stats float pricing each settled message at its model's rate against an editable rate card, in-place Git and LaTeX panels in the conversation view, an embedded Excalidraw whiteboard tab sharing one scene with the model's tools, and a configurable automatic-compaction threshold. |
| [`@deepseek-ai/dsh-tool-excalidraw`](packages/fs/tool-excalidraw/README.md) | Model-facing whiteboard tools — `excalidraw_read`, `excalidraw_write`, `excalidraw_draw`, `excalidraw_export` — over the workspace scene file the canvas tab renders. |
| [`@deepseek-ai/dsh-client-ui-ssh`](packages/client/ui-ssh/README.md) plus [`@deepseek-ai/dsh-remote-ssh`](packages/remote/ssh/README.md), [`@deepseek-ai/dsh-remote-fs-sftp`](packages/remote/fs-sftp/README.md) and [`@deepseek-ai/dsh-remote-subprocess-sftp`](packages/remote/subprocess-sftp/README.md) | SSH/SFTP workspaces: an interactive terminal panel in the Web UI and remote filesystem and subprocess providers over one SFTP seam. |
| [`deploy/brand/`](deploy/brand/README.md) | Background artwork for the Web app, with the light-theme readability constraints the layout imposes and the prompts behind each candidate. |

## Key features

- **Plugin-first architecture.** Every capability — the agent loop, tools, sandboxing, storage, the Web UI — is a Cordis plugin composed from `cordis.yml` patch layers. A deployment picks its stack by composition, not by forking.
- **Multiple runtime surfaces.** The same composed tree powers the [Web UI](docs/user/guide/index.md), the CLI, one-shot headless tasks, an ACP automation server, a JSON-RPC SDK, and the Python SDK.
- **Full agent stack.** Sessions with durable JSONL persistence, system prompts, a tool registry, the agent loop, subagents, background jobs, workflow definitions, and automatic context compaction.
- **Sandboxed execution.** Bash/pwsh shells, a code-execution runtime with Code Mode, and a process-confinement seam backed by bwrap, Landlock, and Seatbelt — each guarded by per-session approval and sandbox policy.
- **Workspace-native tools.** Filesystem read/write/edit with observation policy, git workflows, Excalidraw whiteboards shared between the model and the UI, web search and fetch, LSP, and a skill registry.
- **Session intelligence.** Projection read models (session stats, token usage), SQLite full-text search over history, lineage and relationship queries, and session log export.
- **Extensible surfaces.** Agent presets for per-session composition, installable `dsh --profile` bundle patch layers, hooks bridges for Claude Code and Codex, MCP server integration, and self-modifying extensions.
- **User plane.** User settings with a file backend, credential references, human feedback, goals, plan mode, and interactive approval flows.

See [packages/README.md](packages/README.md) for the package inventory and [docs/architecture.md](docs/architecture.md) for how the pieces compose.

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

This path installs the official build; the customizations in this fork are available only from this repository's source.

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/ReachForStar/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` runs the built entry and uses those artifacts without rebuilding; `pnpm run dsh:source` runs `apps/cli/src/bin.ts` through tsx instead, for launcher-only work.

To bring up the whole local review/bug/planning stack — the Kafka cluster, the three A2A gateways vendored under `deploy/a2a/gateway`, and the Web app — use the stack launcher. It starts only what is not already running:

```sh
cd deploy/a2a/gateway && npm ci && npm run build
cd ../../.. && pnpm run stack:up
```

`pnpm run stack:status` reports each component and `pnpm run stack:down` stops what the launcher started (add `--kafka` to stop the cluster). See [deploy/a2a/README.md](deploy/a2a/README.md).

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
