# @deepseek-ai/dsh-tool-excalidraw

English | [中文](README.zh.md)

The **model-facing Excalidraw scene tools** — `excalidraw_read`, `excalidraw_write`, `excalidraw_draw`, and `excalidraw_export` — over the workspace scene file that the web canvas tab renders. This package owns tool names, JSON schemas, argument validation, and result formatting; the scene file itself lives at `<workspace>/.dsh/excalidraw/scene.json` (`SCENE_RELATIVE`), the same file the `/scene` routes of `@deepseek-ai/dsh-client-ui-polish` persist. The web surface and the model therefore edit one canvas.

```ts ignore-check
// A preset composes the tools into an agent alongside the workspace registry.
- id: tool-excalidraw
  name: '@deepseek-ai/dsh-tool-excalidraw'
```

Mount the row in an agent preset (the shipped `standard` preset already does). The tools derive their target workspace from the calling agent's session: a session owned by a known workspace uses that workspace's path, otherwise the session cwd; a caller with neither is rejected.

## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`excalidraw_read`, `excalidraw_write`, `excalidraw_draw`, and `excalidraw_export` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-excalidraw): `excalidraw_read` returns a scene summary (element counts by type, text elements, theme) plus the complete scene JSON when the file is small; `excalidraw_write` overwrites the workspace scene from a complete scene JSON string; `excalidraw_draw` adds or replaces shapes from a high-level description (`type`, position, size, optional text/points/styling) and fills every rendering field Excalidraw needs, so the model never hand-writes internals; `excalidraw_export` renders the scene to an SVG file in the workspace (pure node-side, no canvas). The model never sees Excalidraw internal element fields it did not author; `excalidraw_draw` accepts only the documented shape vocabulary and rejects unknown element types.

#### Token effect

Per call: the tools return bounded summaries (`excalidraw_read` echoes the full scene JSON only under a 128 KB cap) and error strings on refusal; scene writes echo counts, not content. No prompt section is registered.

#### KV Cache effect

None. The tools register no system-prompt guidance; their schemas are static per deployment.

## Known Limitations and Deferred Work

- **Plain vector export** — `excalidraw_export` reproduces flat fills/strokes; roughjs hand-drawn texture is not rendered node-side.
- **Workspace requirement** — a call without an owning agent session in a workspace is rejected.
