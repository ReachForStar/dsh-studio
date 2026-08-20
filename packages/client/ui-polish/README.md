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

The `/client` exports are the plugin body (`apply`/`inject`), the component prop types, and the injected background-write face type.

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
