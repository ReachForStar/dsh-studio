---
description: "MCP servers tab in the Web Settings Plugins section: the managed fleet's live connection status with authorization, grant removal, and restart over the mcpManager Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-mcp

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-settings-mcp` adds the MCP servers tab to the Web client's Settings → Plugins page. It lists every server the Host's [`dsh-mcp-manager`](../../mcp/mcp-manager/README.md) manages, shows its live connection status, and offers the actions the manager exposes: authorize a remote server that requires OAuth, clear a stored grant, and restart an instance. The tab reads one reconnecting stream, so status changes reach the page without polling.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The Web application bundle mounts this row beside `dsh-mcp-manager`; no configuration is required. Open Settings → Plugins → MCP servers.

| Action | When it appears | What it does |
|---|---|---|
| Authorize | The entry configures `oauth` | Starts the Host's interactive authorization and opens the returned URL in a new browser tab |
| Clear authorization | The entry configures `oauth` | Removes the stored grant; the instance rebuilds and reports `waiting-authorization` |
| Restart | The server is not disabled | Replaces the instance and resets its reconnect budget |

The page shows the Host's status verbatim: connected with a tool count, connecting, reconnecting with an attempt count, waiting for credentials or authorization, failed with its reason, disabled, or closed. A failure's last diagnostic appears under the row. The page never edits configuration; server entries stay with Settings → Plugins configuration and the plugin that registers them.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half registers `settings.plugins.tab` with id `mcp`. `apply` opens one `ctx.remote.$stream` over `mcpManager.watch(signal)` and republishes each list to subscribers; a carrier failure surfaces as an unavailable banner while the stream reconnects. Actions call `mcpManager.authorize`, `mcpManager.forgetAuthorization`, and `mcpManager.restart`, unwrapping the Remote result and reporting the Host's error text under the affected row.

The component is a pure projection of one snapshot plus the action faces, so it renders in tests without a Host. Authorization opens `window.open(url, '_blank', 'noopener,noreferrer')`; a flow that stored tokens without a redirect opens nothing.

The Host half exports an empty `apply` so the plugin has a Loader row; the browser half is discovered from `dsh.client` in the package manifest.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-mcp-manager`](../../mcp/mcp-manager/README.md) — the fleet, its statuses, and the Remote operations this page calls.
- [`dsh-mcp-client`](../../mcp/mcp-client/README.md) — per-instance connection behavior and the OAuth flow.

<a id="model-experience"></a>
## Model Experience

None, as this package is a browser-side settings projection over the `mcpManager` Remote and registers nothing model-facing.

#### KV Cache effect

No model request carries this package's output; it does not affect prompt reuse.

## Known Limitations and Deferred Work

- **Status only, no editing** — server entries are configured through Settings → Plugins and the plugin that registers them; this page adds no field.
- **Authorization needs a reachable loopback callback** — the Host listens on `127.0.0.1` for the redirect, so a remote or SSH-hosted Host needs that port forwarded before the opened URL can complete.
- **The page requires the manager Remote** — a deployment that removes `dsh-mcp-manager` from its Host composition never mounts this tab.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

- Server entries are edited through Settings → Plugins configuration, so this page deliberately stays read-only; a field editor here would duplicate the ConfigEditor contract.
- A per-server probe action from this page is an open direction; the manager already exposes `probe`, but the page has no surface for its stage-classified result.

</details>
