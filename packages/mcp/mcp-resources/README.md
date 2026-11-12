---
description: "Discover and read MCP resources on demand with shared tools, explicit server selection, and agent-scoped access."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-resources

English | [中文](README.zh.md)

## Summary

`dsh-mcp-resources` lets the model discover and read documents from configured MCP servers, and wait for one resource to report a change. Shipped profiles make its four shared tools available automatically when a server is configured in the caller's scope. Each tool requires an explicit server name and contacts the server only when called. Resource text enters conversation history; binary payloads remain available to programmatic callers and appear as descriptions to the model.

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

Shipped profiles already mount this package once. Configure only the [MCP client](../mcp-client/README.md) entries for the servers you need.

### Server configuration

Use the [client configuration](../mcp-client/README.md#use-this-package) to add a server in the intended scope. This package has no configuration fields.

A caller with no configured MCP server sees no MCP prompt text or resource tools in native or PTC mode. A configured server enables the four shared resource tools, including when another provider mounts its client or the server has no tools or instructions. Connection failures do not remove the shared tools while the client entry remains active; resource calls report the connection error.

### Discover and read

When system-prompt assembly is mounted, the prompt lists server names visible to the calling agent. Call `list_mcp_resources` or `list_mcp_resource_templates` with one of those names as `server`. Without a cursor, the MCP SDK collects the server’s pages. An explicit `cursor` requests that page; pass a returned `nextCursor` unchanged. Read a listed URI or an expanded template with `read_mcp_resource`, using the same `server` name and an explicit `uri`.

Every operation resolves the server in the calling agent's scope. A missing server argument or unavailable server fails before dispatch. The connection owner handles request cancellation, timeouts, and recovery; a failed request remains a failed tool call.

### Watch for changes

Call `watch_mcp_resource` with a listed `uri` to wait for the server's first update to that resource. The call subscribes, waits for the first `notifications/resources/updated` for the URI or the timeout, and unsubscribes before returning. `updated: true` means a change arrived; `updated: false` means the wait ended without one. The result never carries the resource body, so read the resource again when you need its content. Omit `timeoutMs` to use the deployment default; the deployment maximum caps larger values. A server that does not advertise `resources.subscribe` fails the call with a clear error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [base](../../bundle/base/README.md) and standalone [sdk-minimal](../../bundle/sdk-minimal/README.md) bundles each own this row:

```yaml
- id: mcp-resources
  name: '@deepseek-ai/dsh-mcp-resources'
```

The first provider in a scope registers its shared tools; removing the last removes those local registrations, while inherited providers and tools remain visible. The resource service owns the shared tool effects independently of the first provider's plugin, so unloading that provider cannot remove tools needed by another server. Provider selection and the server-name prompt use the same scoped registry. Each call resolves its server before dispatch.

Canonical results retain the complete JSON for programmatic callers. The pure text renderer adds server attribution and replaces string-valued `blob` fields with a description of their base64 length; URI, MIME type, and text fields remain in the rendered JSON. A watch returns only its bounded outcome, while the connection owns the subscription, its release, and the wait limit. The tool pipeline owns recorded results. Server instructions belong to the MCP client and its logged system-prompt section.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Scoped provider selection and server-name prompt context |
| [`src/tools.ts`](src/tools.ts) | Shared resource operations and argument schemas |
| [`src/render.ts`](src/render.ts) | Attributed text projection without inline binary payloads |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover server configuration, execution, and the decisions behind resource access.

- [MCP client](../mcp-client/README.md) — server transports, instructions, and connection lifecycle.
- [Tools subsystem](../../../docs/subsystems/tools.md) — canonical values and model-visible results.
- [Resource visibility reference](README.md) — shared profile mounting and visibility from configured servers.
- [Resources and instructions reference](README.md) — scope, on-demand access, and excluded mechanisms.

-----

<a id="model-experience"></a>
## Model Experience

### Shared resource tools

#### What the model sees

The [generated tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-mcp-resources) define four tools shared by all caller-visible configured servers. With none, native schemas, PTC declarations and bindings, and the server-name prompt are absent. Connecting, disconnecting, or retrying an active client leaves these shared tool definitions unchanged. When system-prompt assembly is mounted and providers are visible, the `MCP resource servers` section says `Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: <JSON array>. Call watch_mcp_resource with the same server name and a resource URI to wait for that resource's next update.` The names come from the same scoped registry, including servers with neither tools nor instructions. An empty registry contributes no section.

#### Token effect

With no caller-visible configured servers, this package adds no tool or prompt tokens. Otherwise, four shared definitions contribute a fixed schema cost and the server-name section adds a sorted JSON list of visible names. Resource listings and documents add content only when an operation returns them.

#### KV Cache effect

Adding the first caller-visible server or removing the last changes the next tool schema or PTC declaration prefix. Changes to visible names update the server-name section; replacing a provider under the same name leaves that text unchanged. Connection failures alone do not change the shared definitions or names.

### Resource results

#### What the model sees

A successful result starts with `MCP server: <server>`, followed by a newline and the returned JSON. Each string-valued `blob` becomes `[binary resource: <length> base64 characters; available to programmatic callers]`. Server-provided text, metadata, and continuation cursors remain visible.

#### Token effect

Rendered results add text to tool history. Binary descriptions replace the payload's base64 token cost; this package imposes no separate text-size limit.

#### KV Cache effect

Each result appends to history without rewriting earlier results. Later reads can return changed server content and append a different result; the package does not refresh previously recorded content.

### Resource watch results

#### What the model sees

A completed watch appends one attributed line: `MCP server: <server>` followed by `MCP resource "<uri>" reported a change after <n> ms. Read it again to get the new content.` or `... reported no change within <n> ms. Read it again to check its current content.` The canonical value carries only the URI, the update flag, and the wait duration; no resource body or server payload enters the result.

#### Token effect

Each watch adds one fixed sentence plus the URI to tool history. Wait duration digits are the only variable cost beyond the URI; resource content is read separately.

#### KV Cache effect

Append-only; a later watch result follows the existing prefix and does not rewrite earlier results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Resource access is explicit and on demand.

- A configured server without the MCP `resources` capability still appears in the server-name prompt and keeps shared resource tools available. The MCP client returns empty resource and template lists without contacting the server; unsupported reads fail.
- `tools.restrict()` checks names supplied by global or ancestor scopes when the filter is registered. Naming a resource tool absent from those scopes fails as an unknown tool. Resource tools registered in the caller's own scope are outside allow/deny masks.
- Resource watches cover one URI and one update per call. Each call waits for the first `notifications/resources/updated` for that URI or its timeout, then unsubscribes; it does not stream later updates, aggregate several servers, or report `notifications/resources/list_changed`. A server that does not advertise `resources.subscribe` fails the call. A watch whose connection closes while waiting fails; call it again after reconnection.
- Binary resources are not projected as native images or audio. Programmatic callers retain their canonical base64 values.
- The caller must supply a server name. The shared tools do not aggregate different servers; pagination follows the MCP SDK.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
