---
description: "Configure a Web GUI background, compaction threshold, model rate card, workspace tools, LaTeX editing, and SSH/SFTP terminal features."
kind: "package-reference"
---

# @reachforstar/dsh-client-ui-polish

English | [中文](README.zh.md)

## Summary

Use this package to configure the Web GUI background, automatic context-compaction threshold, and model rate card. It also adds Git, LaTeX, Excalidraw, and SSH/SFTP views without changing the agent loop. Choose it when a Web profile needs these product-facing controls; the package adds client bundle weight because it embeds Excalidraw and xterm.js.

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

Mount this package in a Web browser roster when the profile needs configurable presentation, workspace editing, or SSH/SFTP access.

### When to choose it

Choose this package for a local Web profile that needs background customization, model cost display, or a full SSH/SFTP terminal. Do not mount it in a headless profile; its browser slots and host HTTP routes require the Web composition.

### Minimal configuration

```yaml
- id: ui-polish
  name: '@reachforstar/dsh-client-ui-polish'
```

The package has no required configuration fields. Its user settings are edited from the Web UI; the generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for accepted composition fields.

-----

## Features

Web GUI polish plugin, browser half plus a small host half — enhancements that need no core package changes:

- **Whole-app background image.** The plugin owns its `ui-polish` settings namespace and paints the image onto the body (`cover` / fixed / centered), marking the document with `data-ds-bg-image`. Its injected global stylesheet overrides the base tokens (`--dsw-alias-bg-base`, `--dsw-specific-sidebar-fill`) to transparent while the attribute is set, so the structural surfaces — app frame, conversation, details, and sidebar — yield to the image; content elements that need contrast (cards, code blocks, buttons) keep their own fills. The settings row in the General section uploads (with size/type validation), previews, and removes the image. The image is persisted as a **file on disk** (served at `/bg/current`) — the settings document stores only the short URL, never megabytes of base64 — so it survives restarts without bloating the settings file.
- **Workspace stats float with cost.** A `conversation.composer.dock` entry pinned to the viewport's top-right via `position: fixed` shows the durable `sessionStats` figures of the session on screen (window-fold fallback for assemblies without that projection) plus the tokens and spend of **every session in its workspace**: each session reports its tokens through the projection values its row in the session list carries, and the session on screen reports its live projection instead. Spend is priced per session — a session whose settled messages this client holds is billed message by message at each message's own model and settle time (so time-tiered models like deepseek switch between peak and off-peak prices, and length-tiered models pick the tier covering the input length), while a session known only through its projection is billed at the card's `default` rate, because the wire projection carries bucket totals without model attribution; the per-model breakdown row therefore appears only when a single session contributed. The card leads with the workspace total, then splits it into input, cache, and output buckets over a share bar with the exact figures beside it, shows the token triple as chips, and lists each contributing model with its own share and subtotal; timing and cache-hit figures sit last as the quietest line. Collapsed, it is a capsule carrying the total and the token triple. The **rate card** (CNY per 1M tokens) is the built-in `src/client/model-pricing.json` seed converted once from the amaxsmp gateway pricing; the General-settings **Model rate card** row edits the card as JSON and persists it in the settings document, so a custom card survives restarts and re-prices the float immediately. Unknown models fall back to the card's `default` entry.
- **SSH/SFTP panel.** A `conversation.view` tab with stored connection selection, remote command probing, interactive PTY, and SFTP directory/file operations. Control calls use the generated `ssh` Remote namespace; PTY output and exit use the shared Remote Event stream; file transfers use authenticated Host Fetch routes.
- **Git panel.** A `conversation.view` tab (in the top tab ring right after the trajectory tab) covering every repository discovered inside the workspace the browser is viewing: branch and ahead/behind, working-tree groups (conflicts / staged / changes / untracked) with a per-file diff drawer — images side by side with a fullscreen view — a commit box whose message can be generated from editable commit rules through an LLM, and a history graph. Actions span stage, unstage, discard, delete, commit (and commit-and-push), undo-commit, push, pull, branch switch and creation, stash, resets, clean, and merge completion or abort.
- **LaTeX panel.** A `conversation.view` tab with an Overleaf-style workflow over the local TeX distribution: project discovery, file tree, in-place `.tex` editing, compilation with xelatex (Chinese and English through ctex/xeCJK) plus bibtex when a bibliography is referenced, a live PDF preview of the cached result, project font installation, `tlmgr` package installation, build-artifact cleanup, and an LLM writing assistant over the file or the current selection. Compilation mirrors the project into a temp directory, so the workspace tree stays free of build artifacts.
- **Excalidraw canvas tab.** A `conversation.view` tab embedding the Excalidraw whiteboard in-document (no iframe). The canvas persists scene files to `<workspace>/.dsh/excalidraw/scene.json` through `/scene/current` and `/scene/write` — the same file the model-facing `excalidraw_*` tools in `@reachforstar/dsh-tool-excalidraw` read and write, so model-drawn content appears live via a fingerprint poll. Excalidraw and its dependencies inline into the client bundle (large); react/react-dom come from the platform.
- **No file-browsing tab.** Browsing and previewing files stays with the built-in right-sidebar Files tree and the document preview pane; this package ships no duplicate file view.
- **Automatic context compaction threshold.** A General-settings row selects the context-pressure ratio (50–80%, or the 80% harness default when unset) at which the session's compaction backend compacts automatically. The choice persists in the `ui-polish` settings document; the node half reads it per step and, when it is below the harness default, measures pressure at `agent/pre-step` and asks the agent's own compaction service (via the roster's agent-addressed service face) to compact first — never double-compacting with the built-in 0.8 listener.

The host half registers the `/git`, `/latex`, `/bg`, and `/scene` route prefixes on the host webserver, resolving each request's `cwd` against the live workspace registry (switching workspaces switches the repository without a restart, and a nested repository or worktree resolves through its own path), and runs `git` through `execFile` with array arguments (no shell). Paths containing `..` or separators are rejected, unknown cwds fall back to the host process cwd, and a non-repo directory shows a quiet notice.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half registers independent settings and conversation slots. The host half owns the background, workspace, Git, LaTeX, Excalidraw, and SSH/SFTP routes. Settings values travel through `settingsScope`; SSH control calls use the generated `ssh` Remote namespace, PTY events use the shared Remote Event stream, and file transfers use authenticated Fetch routes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web application bundle](../../bundle/web-app/README.md) — shipped Web composition.
- [SSH capability](../../remote/ssh/README.md) — provider-independent SSH connection and SFTP contract.
- [Host SSH Remote gateway](../../host/ssh-remotes/README.md) — browser-facing SSH methods and routes.
- [Configuration catalog](../../../docs/config-catalog.md) — exhaustive composition fields.

-----

## Installation

Mount the plugin as a browser-roster row in the web-app bundle (`cordis.patch.yml`), exactly like the built-in client plugins; the shipped `dsh-web-app` patch already carries it:

```yaml ignore-check
- id: ui-polish
  name: '@reachforstar/dsh-client-ui-polish'
```

The model-facing whiteboard tools (`excalidraw_read`/`write`/`draw`/`export`) live in the separate [`@reachforstar/dsh-tool-excalidraw`](../../fs/tool-excalidraw/README.md) package and mount through an agent-preset row (the shipped `standard` preset already carries it):

```yaml ignore-check
- id: tool-excalidraw
  name: '@reachforstar/dsh-tool-excalidraw'
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

The node half registers four prefixes on the host webserver; every request carries the workspace `cwd` (in the query for GETs, in the JSON body for POSTs) resolved per request against the live workspace registry:

| Route | Method | Purpose |
|---|---|---|
| `/git/repos` | GET `?cwd` | Repositories discovered inside the workspace, nested repositories and worktrees included. |
| `/git/status` `/git/branches` `/git/log` | GET `?cwd` | Branch and ahead/behind, porcelain groups and merge state, the branch list, and commit metadata with optional diffstat totals. |
| `/git/show` `/git/blob` | GET `?cwd&ref&path` | One file at a revision; raw blob bytes for image previews. |
| `/git/diff` | POST `{cwd, path, staged, untracked}` | Working-tree or index diff for one file. |
| `/git/stage` `/git/unstage` `/git/discard` `/git/clean` | POST `{cwd, paths}` | Index and working-tree mutations. |
| `/git/commit` `/git/undo-commit` | POST `{cwd, message, paths, push}` | Commit the given paths (optionally pushing), or soft-reset the last commit. |
| `/git/push` `/git/pull` `/git/switch` `/git/stash` `/git/reset` | POST `{cwd, ...}` | Push, fetch and merge the upstream, switch or create a branch, list/push/pop stashes, and soft/mixed/hard reset. |
| `/git/merge-abort` `/git/merge-complete` | POST `{cwd}` | Abort or finish an in-progress merge. |
| `/git/rules` `/git/models` | GET `?cwd&repo` | The effective commit rule with its source, and the generator's model catalog. |
| `/git/rules-save` `/git/rules-reset` `/git/generate` `/git/generate-cancel` | POST | Persist or clear a commit rule; stream a generated commit message as NDJSON, or cancel it. |
| `/latex/projects` `/latex/list` `/latex/read` `/latex/write` | POST `{cwd, dir, path}` | Project discovery, file tree, file content, and in-place save. |
| `/latex/compile` `/latex/clean` `/latex/fonts` `/latex/ai` | POST `{cwd, dir, ...}` | Compile into a temp mirror (xelatex plus bibtex), delete build artifacts, list or install fonts and `tlmgr` packages, and run the LLM writing assistant. |
| `/latex/pdf` | GET `?cwd&dir&main` | The cached PDF of the last successful compile. |
| `/bg/current` `/bg/upload` `/bg` | GET/POST/DELETE | The persisted background image file, upload, and delete. |
| `/scene/current` `/scene/write` | POST `{cwd, scene}` | The workspace Excalidraw scene JSON, or overwrite it. |

`git` runs through `execFile` with array arguments — no shell, so paths and commit messages never reach a shell. Paths containing `..` or a path separator are rejected, and an unknown `cwd` falls back to the host process directory (the browser tabs then show a non-repo notice).

## Slots

The browser half registers into five slots:

| Slot | id | Purpose |
|---|---|---|
| `settings.general.item` | `polish-background` | Background image upload / preview / remove. |
| `settings.general.item` | `polish-compaction` | Automatic-compaction threshold select. |
| `settings.general.item` | `polish-pricing` | Model rate card JSON editor. |
| `conversation.composer.dock` | `polish-stats` | Workspace stats float with cost (viewport-pinned). |
| `conversation.view` | `git` | Git panel (repositories, status, diff, commit, push, log). |
| `conversation.view` | `latex` | LaTeX project editor with xelatex compilation and PDF preview. |
| `conversation.view` | `excalidraw` | Excalidraw whiteboard tab. |
| `conversation.view` | `ssh` | SSH/SFTP PTY panel. |

<a id="model-experience"></a>
## Model Experience

None, as the plugin is pure client-side presentation plus host HTTP and settings plumbing, and the model-facing whiteboard tools live in `@reachforstar/dsh-tool-excalidraw`.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Fixed-position floats** — the stats card pins itself with `position: fixed` (the standalone plugin cannot reparent core layout), so it overlays the viewport corner regardless of the composer's own position.
- **Token-override transparency** — while a background image is active, every surface painting the base tokens becomes transparent, including some content elements that read `--dsw-alias-bg-base` (e.g. code blocks), which can reduce their contrast on a busy image.
- **Plain-text file editing** — the Git panel edits files in a monospace textarea, not a syntax-highlighted editor; the LaTeX editor is a plain textarea as well.
- **Local TeX dependency** — the LaTeX panel compiles with the machine's own TeX distribution (`xelatex`, `bibtex`, `tlmgr`); a machine without them reports a missing-engine error instead of a degraded preview.
- **Background upload cap** — images are capped at 2MB (the served copy is a file on disk; the settings document keeps only the URL).
- **Bundle weight** — the Excalidraw canvas tab inlines the whiteboard library into the client bundle (~12 MB uncompressed), so the whole plugin bundle is heavy; the canvas tab is the only consumer of that weight.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
