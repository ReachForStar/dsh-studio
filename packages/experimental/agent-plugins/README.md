---
description: "Agent Plugins v1 loader: publish a portable plugin.json package's skills and MCP servers through the harness skill and MCP seams."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-plugins

English | [中文](README.zh.md)

## Summary

Load [Agent Plugins v1](https://agent-plugins.org/) packages without rewriting them. A configured package contributes its `skills/<dir>/SKILL.md` files to `ctx.skills` and its root `mcp.json` entries to `ctx.mcpManager`, so one directory works for every tool that understands the portable layout. The loader reads package files and never writes them; its only write is the per-package `PLUGIN_DATA` directory that stdio servers receive. Mount it when a composition should adopt third-party packages instead of installing each capability as a harness plugin.

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

### When to choose it

Choose it when users install portable Agent Plugins packages and expect their skills and MCP servers to appear in a session. Do not use it to load harness plugins: those are Cordis packages mounted by the loader.

### Mount it

```yaml
- id: agent-plugins
  name: '@deepseek-ai/dsh-agent-plugins'
  config:
    plugins:
      - /opt/agent-plugins/review-kit
    dataRoot: /var/lib/dsh/plugin-data
```

`plugins` lists package directories, absolute or relative to the process working directory. `dataRoot` defaults to `<dsh home>/plugin-data`; the loader creates `<dataRoot>/<package name>` before registering that package's stdio servers. `skillRank` defaults to `300`, the same rank as a custom skill root, and decides which skill wins when two providers publish the same name.

A configured directory must hold a valid v1 `plugin.json`. A missing root, a symlinked manifest that escapes the root, or an invalid manifest fails plugin activation: the path came from configuration, so the loader refuses to run with a package the user asked for and did not get.

### What a package may contain

| Component | Location | Published as |
|---|---|---|
| Skills | `skills/<dir>/SKILL.md` | One skill candidate per directory; the frontmatter `name` must equal the directory name, `description` must be 1-1024 characters |
| MCP servers | `mcp.json` → `mcpServers` | `stdio` and `streamable-http` entries; `sse` and unknown transports are skipped |

Entries may use `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`. Stdio entries receive both values in their environment, and `cwd` defaults to `${PLUGIN_ROOT}`. Existing components of the same package keep working when one component is invalid.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Containment

Every component path is resolved with `realpath` and must stay inside the package root. A manifest escape rejects the package; a skill or MCP entry escape skips that component only. The check runs before any content reaches a catalog or a registration.

### Names and collisions

A registered MCP server name is `<package name>-<entry name>`, with characters outside `[A-Za-z0-9_-]` replaced by `-`. Names longer than the 32-character MCP namespace limit keep the first 23 characters plus an 8-character hash of the full name, so distinct long entries cannot collide silently. When two packages produce the same server name, the first registration wins and the loader warns with both names.

<a id="further-exploration"></a>
## Further Exploration

- [Agent Plugins v1 specification](https://agent-plugins.org/)
- [`dsh-skill`](../../skill/skill/README.md) — the provider registry these skills join
- [`dsh-mcp-manager`](../../mcp/mcp-manager/README.md) — the manager these servers register with
- [`dsh-skill-filesystem`](../../skill/skill-filesystem/README.md) — local skill discovery for comparison

<a id="model-experience"></a>
## Model Experience

### Skill catalog

#### What the model sees

Package skills appear in the same catalog as filesystem skills: invocable names with their descriptions, and a selected body on demand. The loader adds no text of its own.

#### Token effect

Only the winning skills the catalog already lists; bodies cost tokens when the model loads one.

#### KV Cache effect

Append-only, through the existing skill catalog and tool results; the loader changes nothing in the request prefix.

### MCP tools

#### What the model sees

Tools of a registered server appear under the `mcp__<server>-` namespace exactly as configured MCP servers do. The loader adds no instructions or session events.

#### Token effect

Each advertised tool adds its schema to every request while its server is registered.

#### KV Cache effect

Registering or withdrawing a server rewrites the tool block; steady state appends nothing.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only the two portable components are loaded. Agent Plugin commands, agents, hooks, context, settings, channels, and apps are ignored.
- A package change requires a restart: the loader reads manifests and components once, during activation.
- Legacy `sse` transports are skipped rather than translated.
- Packages are not installed, downloaded, or verified against a marketplace; the user supplies directories.
- A non-absence filesystem error while listing skills or reading a skill file fails the lookup instead of degrading it.

<a id="dev-note"></a>
### Dev Note

Package files are never rewritten; every write the loader performs is the per-package `PLUGIN_DATA` directory. Coverage stays at 100% per file, and the two native non-absence I/O failures carry narrow `v8 ignore` annotations with reasons.
