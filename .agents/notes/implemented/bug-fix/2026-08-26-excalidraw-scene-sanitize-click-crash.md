# Agent Note: 规范化 Excalidraw 场景元素，修复点击画布就崩溃消失

Status: implemented

English | [中文](2026-08-26-excalidraw-scene-sanitize-click-crash.zh.md)

## Problem

The embedded Excalidraw panel (`ExcalidrawPanel`) vanished (unmounted, leaving only the DSH background) when the user clicked any shape. The failure was reproducible as a loop: reload the canvas → shapes render → click a shape → the whole panel disappears → reload → shapes return → click → disappear again. No agent running, no session switch.

The root cause was **malformed elements in the scene file** at `<workspace>/.dsh/excalidraw/scene.json`. The affected canvas's scene (a large hand-assembled architecture diagram) contained elements that are not in Excalidraw's native schema:

- Three `zone_*` rectangles (`zone_94a3b8`, `zone_7fb89a`, `zone_b48ec9`) with `version: null` and **no `seed`** field, plus missing `angle`/`isDeleted`/`roundness`/`groupIds`/`frameId`/`boundElements`/`link`/`locked`.
- One `image` element (`1TZWjMC5GZODShrs7ZDT4`) in `status: "pending"` with no backing file data.

Excalidraw tolerates these on initial `updateScene` (the shapes render), but **clicking** a shape triggers the real render/bind path. A missing `seed` makes roughjs throw during path generation (the draw tool's own comment documents this exact failure); a file-less `image` has no data source to render. The thrown exception is caught by `SlotErrorBoundary` (scoped-slots) which unmounts the whole panel, leaving the background. Reload re-mounts and the loop repeats.

The frontend's poll loop was ruled out: `sceneFingerprint` compares only `id:type:text`, which does not change on click, so the 2s poll never reloads the canvas on user interaction.

## Decision

Add a shared `sanitizeScene()` normalization in `@deepseek-ai/dsh-tool-excalidraw` (the scene contract owner, where `SCENE_RELATIVE` lives) and apply it at every scene ingress/egress:

- **`excalidraw_service.ts` `/scene/current`** — repair before the scene reaches the panel's `loadScene` and the 2s poll, so the canvas never receives a scene it crashes on.
- **`excalidraw_service.ts` `/scene/write`** — repair before persisting the frontend's self-save round-trip.
- **`tool-excalidraw` `excalidraw_write`** — repair before the model's write lands on disk (this tool writes the scene file directly, bypassing the HTTP routes).

`sanitizeScene` fills render-critical defaults idempotently: `seed` (deterministic hash of the element id, so re-reading never changes a scene and never perturbs `sceneFingerprint`), `version` (null/undefined → 1), `angle`/`roundness`, and shape-geometry group/container fields. File-less or `pending` `image` elements are dropped (they cannot render). Well-formed elements pass through untouched.

A one-off script (run via node against the real scene file) repaired the existing damaged scene: 389 → 388 elements, the three `zone_*` rectangles got `seed`/`angle`/`roundness`/`isDeleted` and `version` 1, and the pending image was removed.

## Alternatives considered

**Repair only in the frontend (`handleChange`/poll).** Rejected — the frontend's `handleChange` already receives Excalidraw's own (well-formed) elements; the malformed data enters through the scene file, so the boundary that must normalize is the scene read/write. A frontend-only fix would not cover the model's `excalidraw_write` path, which writes the file directly.

**Repair with a random seed.** Rejected — a random seed makes normalization non-idempotent; re-reading the same file repeatedly would mutate it. A deterministic id-hash seed is stable across passes.

## Consequences

- Scenes from any source (user import, model `excalidraw_write`, legacy files) are normalized before the panel renders them.
- `sanitizeScene` is exported from `@deepseek-ai/dsh-tool-excalidraw` and re-used by the web surface, so the two paths share one contract (no drift).
- The two existing round-trip tests that asserted byte-equal on-disk content were updated to assert the repaired (user-supplied + default-filled) equivalent, plus new unit tests for the malformed-element, dropped-image, and well-formed-pass-through cases.
