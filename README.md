# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

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

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
