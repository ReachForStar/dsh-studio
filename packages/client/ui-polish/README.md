# @deepseek-ai/dsh-client-ui-polish

English | [中文](README.zh.md)

Web GUI polish plugin, browser half plus a small host half — enhancements that need no core package changes:

- **Whole-app background image.** The plugin owns its `ui-polish` settings namespace and paints the image onto the body (`cover` / fixed / centered), marking the document with `data-ds-bg-image`. Its injected global stylesheet overrides the base tokens (`--dsw-alias-bg-base`, `--dsw-specific-sidebar-fill`) to transparent while the attribute is set, so the structural surfaces — app frame, conversation, details, and sidebar — yield to the image; content elements that need contrast (cards, code blocks, buttons) keep their own fills. The settings row in the General section uploads (with size/type validation), previews, and removes the image. The image is persisted as a **file on disk** (served at `/bg/current`) — the settings document stores only the short URL, never megabytes of base64 — so it survives restarts without bloating the settings file.
- **Session stats float with cost.** A `conversation.composer.dock` entry pinned to the viewport's top-right via `position: fixed` shows the durable `sessionStats` and `tokenUsage` projection figures (window-fold fallback for assemblies without the former), plus an estimated spend billed per model with an input/cache/output bucket split shown directly under the total: a state-only Conversation Definition records each settled assistant message's model (messageId → model) into a plugin-owned index, and each step's usage is priced at its own model's rate and its own settle time (so time-tiered models like deepseek switch between peak and off-peak prices, and length-tiered models pick the tier covering the input length). The **rate card** (CNY per 1M tokens) is the built-in `src/client/model-pricing.json` seed converted once from the amaxsmp gateway pricing; the General-settings **Model rate card** row edits the card as JSON and persists it in the settings document, so a custom card survives restarts and re-prices the float immediately. Unknown models fall back to the card's `default` entry.
- **File panel.** A `conversation.view` tab (between the trajectory and Git tabs) browsing the workspace repository's directory tree: directories expand lazily via `/git/list`, and selecting a file reads its current content through `/git/read` into an editable textarea; saving writes it back via `/git/write` — the file is edited in place, never handed to a third-party app.
- **Git panel.** A `conversation.view` tab (in the top tab ring right after the file tab) showing the workspace repository the browser is currently viewing: branch, working-tree changes with per-file diffs, a commit box (`add -A` + commit), a push action, and recent commits in a two-column layout. Selecting a changed file opens it in the right column for in-place editing (same `/git/read` + `/git/write`).
- **Excalidraw canvas tab.** A `conversation.view` tab embedding the Excalidraw whiteboard in-document (no iframe). The canvas persists scene files to `<workspace>/.dsh/excalidraw/scene.json` through `/scene/current` and `/scene/write` — the same file the model-facing `excalidraw_*` tools in `@deepseek-ai/dsh-tool-excalidraw` read and write, so model-drawn content appears live via a fingerprint poll. Excalidraw and its dependencies inline into the client bundle (large); react/react-dom come from the platform.
- **Automatic context compaction threshold.** A General-settings row selects the context-pressure ratio (50–80%, or the 80% harness default when unset) at which the session's compaction backend compacts automatically. The choice persists in the `ui-polish` settings document; the node half reads it per step and, when it is below the harness default, measures pressure at `agent/pre-step` and asks the agent's own compaction service (via the roster's agent-addressed service face) to compact first — never double-compacting with the built-in 0.8 listener.

The host half registers the `/git`, `/bg`, and `/scene` route prefixes on the host webserver, resolving each request's `cwd` against the live workspace registry (switching workspaces switches the repository without a restart), and runs `git` through `execFile` with array arguments (no shell). Paths containing `..` or separators are rejected, unknown cwds fall back to the host process cwd, and a non-repo directory shows a quiet notice.

## Installation

Mount the plugin as a browser-roster row in the web-app bundle (`cordis.patch.yml`), exactly like the built-in client plugins; the shipped `dsh-web-app` patch already carries it:

```yaml ignore-check
- id: ui-polish
  name: '@deepseek-ai/dsh-client-ui-polish'
```

The model-facing whiteboard tools (`excalidraw_read`/`write`/`draw`/`export`) live in the separate [`@deepseek-ai/dsh-tool-excalidraw`](../../fs/tool-excalidraw/README.md) package and mount through an agent-preset row (the shipped `standard` preset already carries it):

```yaml ignore-check
- id: tool-excalidraw
  name: '@deepseek-ai/dsh-tool-excalidraw'
```

The node half waits for the optional `settings` and `webServer` services via `ctx.inject`, so the plugin loads harmlessly in compositions without them.

## Settings

The plugin owns the `ui-polish` namespace in the user-settings document (validated by `PolishSettingsSchema`):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `backgroundImage` | `string` (URL) | absent | Served background image (`/bg/current`), or a legacy data URL; absent clears the background. |
| `compactionThresholdRatio` | `number` (0.5–0.8) | absent (harness 0.8) | Pressure ratio at which the node half asks the session's compaction service to compact. |
| `modelPricing` | `string` (JSON) | absent (built-in seed card) | User-edited rate card pricing the stats float; see **Model rate card** below. |

Only the background-image and compaction fields existed in the original standalone plugin; the rate card is the integrated package's extension (see the next section).

## Model rate card

The stats float prices each settled assistant message at its own model's rate and settle time against a rate card (CNY per 1M tokens). The built-in card in `src/client/model-pricing.json` is a snapshot converted from the amaxsmp gateway pricing; the General-settings **Model rate card** row edits the card as JSON (`{ default, models }`) and persists it in `modelPricing`. A saved card survives restarts and re-prices the float immediately; invalid JSON or a non-finite price is rejected with a field-level message and nothing is persisted. Unknown models fall back to the card's `default` entry; time-tiered models (deepseek) switch at peak/off-peak boundaries and length-tiered models pick the tier covering the billed input.

## Host routes

The node half registers three prefixes on the host webserver; every request carries the workspace `cwd` (in the query for GETs, in the JSON body for POSTs) resolved per request against the live workspace registry:

| Route | Method | Purpose |
|---|---|---|
| `/git/list` | POST `{cwd, dir?}` | Directory entries (files + subdirs), directories first; `dir` is repo-relative. |
| `/git/read` | POST `{cwd, path}` | File content (or a data URL for image previews). |
| `/git/write` | POST `{cwd, path, content}` | Overwrite a file in place. |
| `/git/status` | GET `?cwd` | Branch + porcelain working-tree status. |
| `/git/diff` | GET `?cwd&path` | Working-tree diff for one file. |
| `/git/log` | GET `?cwd` | Recent commit subjects. |
| `/git/commit` | POST `{cwd, message}` | `add -A` + commit. |
| `/git/push` | POST `{cwd}` | Push the current branch. |
| `/bg/current` | GET | The persisted background image file. |
| `/bg/upload` | POST (raw body) | Upload a background image (≤ 2MB); returns `{url}`. |
| `/bg` | DELETE | Best-effort delete of the persisted file. |
| `/scene/current` | POST `{cwd}` | The workspace Excalidraw scene JSON, or 404 when none exists. |
| `/scene/write` | POST `{cwd, scene}` | Overwrite the workspace scene file (validated JSON). |

`git` runs through `execFile` with array arguments — no shell, so paths and commit messages never reach a shell. Paths containing `..` or a path separator are rejected, and an unknown `cwd` falls back to the host process directory (the browser tabs then show a non-repo notice).

## Slots

The browser half registers into five slots:

| Slot | id | Purpose |
|---|---|---|
| `settings.general.item` | `polish-background` | Background image upload / preview / remove. |
| `settings.general.item` | `polish-compaction` | Automatic-compaction threshold select. |
| `settings.general.item` | `polish-pricing` | Model rate card JSON editor. |
| `conversation.composer.dock` | `polish-stats` | Session stats float with cost (viewport-pinned). |
| `conversation.view` | `files` | Workspace file browser / editor. |
| `conversation.view` | `git` | Git panel (status, diff, commit, push, log). |
| `conversation.view` | `excalidraw` | Excalidraw whiteboard tab. |

## Model Experience

None, as the plugin is pure client-side presentation plus host HTTP and settings plumbing, and the model-facing whiteboard tools live in `@deepseek-ai/dsh-tool-excalidraw`.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Fixed-position floats** — the stats card pins itself with `position: fixed` (the standalone plugin cannot reparent core layout), so it overlays the viewport corner regardless of the composer's own position.
- **Token-override transparency** — while a background image is active, every surface painting the base tokens becomes transparent, including some content elements that read `--dsw-alias-bg-base` (e.g. code blocks), which can reduce their contrast on a busy image.
- **Plain-text file editing** — the file and git panels edit files in a monospace textarea, not a syntax-highlighted editor.
- **Background upload cap** — images are capped at 2MB (the served copy is a file on disk; the settings document keeps only the URL).
- **Bundle weight** — the Excalidraw canvas tab inlines the whiteboard library into the client bundle (~12 MB uncompressed), so the whole plugin bundle is heavy; the canvas tab is the only consumer of that weight.
