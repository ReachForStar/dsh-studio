---
description: "Use model-facing Excalidraw tools to read, write, draw, and export the workspace whiteboard scene."
kind: "package-reference"
---

# @reachforstar/dsh-tool-excalidraw

English | [中文](README.zh.md)

## Summary

Use this package when an agent must inspect, replace, extend, or export the same Excalidraw scene shown by the Web canvas. The tools keep scene and export paths inside the owning workspace and return bounded summaries instead of unbounded scene data.

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

Mount these tools in an agent preset whose sessions belong to a known workspace.

### When to choose it

Choose this package when the model and Web canvas must edit one workspace-owned whiteboard. Avoid it when no Workspace registry is available or when exports require roughjs texture rendering.

### Minimal configuration

```yaml
- id: tool-excalidraw
  name: '@reachforstar/dsh-tool-excalidraw'
```

The package has no configuration fields; the generated [tool catalog](../../../docs/tool-catalog.md#reachforstardsh-tool-excalidraw) owns the exact model-visible schemas.

-----

## Scene tools

The **model-facing Excalidraw scene tools** — `excalidraw_read`, `excalidraw_write`, `excalidraw_draw`, and `excalidraw_export` — over the workspace scene file that the web canvas tab renders. This package owns tool names, JSON schemas, argument validation, and result formatting; the scene file itself lives at `<workspace>/.dsh/excalidraw/scene.json` (`SCENE_RELATIVE`), the same file the `/scene` routes of `@reachforstar/dsh-client-ui-polish` persist. The web surface and the model therefore edit one canvas.

```ts ignore-check
// A preset composes the tools into an agent alongside the workspace registry.
- id: tool-excalidraw
  name: '@reachforstar/dsh-tool-excalidraw'
```

Mount the row in an agent preset (the shipped `standard` preset already does). The tools derive their target workspace from the calling agent's session: a session owned by a known workspace uses that workspace's path, otherwise the session cwd; a caller with neither is rejected.

## Scene file

All four tools read and write the same file: `<workspace>/.dsh/excalidraw/scene.json` (the `SCENE_RELATIVE` export), an Excalidraw scene object with an `elements` array and an `appState` object. The file lives under the workspace's hidden `.dsh` directory, out of the visible working tree, and is the exact file the web canvas tab (`@reachforstar/dsh-client-ui-polish`'s `/scene` routes) renders — so a model draw appears on the whiteboard live, and a canvas edit is what the next tool call reads.

The scene is plain JSON; the tools enforce the following boundaries:

| Boundary | Value |
|---|---|
| `excalidraw_read` full-JSON echo cap | 128 KB |
| `excalidraw_write` scene size cap | 1 MB |
| `excalidraw_draw` elements per call | 256 |
| Export path escape | rejected (`..`, leading `/`, backslash) |

A missing scene reads as an empty canvas; a corrupt (non-JSON) scene reads as empty with an `error` field and refuses writes only at parse time.

## Security

Scene and export paths resolve inside the calling workspace: `excalidraw_export`'s `path` argument must stay workspace-relative (no `..`, no leading slash, no backslash), and the scene file itself is always the workspace-relative `SCENE_RELATIVE`. The tools use node's `fs/promises` with no shell involved, so a model-supplied path can never escape the workspace or reach a shell.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package resolves the calling agent's Workspace, validates scene and export paths, and reads or writes one shared JSON scene file. The Web canvas and model-facing tools therefore converge on the same durable file without a second synchronization store.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web GUI polish](../../client/ui-polish/README.md) — canvas and scene routes.
- [Workspace capability](../../workspace/workspace/README.md) — Workspace ownership and lookup.
- [Generated tool catalog](../../../docs/tool-catalog.md#reachforstardsh-tool-excalidraw) — exact tool schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`excalidraw_read`, `excalidraw_write`, `excalidraw_draw`, and `excalidraw_export` schemas](../../../docs/tool-catalog.md#reachforstardsh-tool-excalidraw): `excalidraw_read` returns a scene summary (element counts by type, text elements, theme) plus the complete scene JSON when the file is small; `excalidraw_write` overwrites the workspace scene from a complete scene JSON string; `excalidraw_draw` adds or replaces shapes from a high-level description (`type`, position, size, optional text/points/styling) and fills every rendering field Excalidraw needs, so the model never hand-writes internals; `excalidraw_export` renders the scene to an SVG file in the workspace (pure node-side, no canvas). The model never sees Excalidraw internal element fields it did not author; `excalidraw_draw` accepts only the documented shape vocabulary and rejects unknown element types.

#### Token effect

Per call: the tools return bounded summaries (`excalidraw_read` echoes the full scene JSON only under a 128 KB cap) and error strings on refusal; scene writes echo counts, not content. No prompt section is registered.

#### KV Cache effect

None. The tools register no system-prompt guidance; their schemas are static per deployment.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Plain vector export** — `excalidraw_export` reproduces flat fills/strokes; roughjs hand-drawn texture is not rendered node-side.
- **Workspace requirement** — a call without an owning agent session in a workspace is rejected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
