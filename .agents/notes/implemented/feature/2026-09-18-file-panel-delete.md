# Agent Note: Permanent deletion in the fork file panel

Status: implemented

English | [中文](2026-09-18-file-panel-delete.zh.md)

## Problem

The fork's file panel (`ui-polish`'s `MutationDiffPanel`, the conversation view's File tab) browses a workspace tree through the host's `/git/*` routes and edits files in place, but nothing could remove an entry: deleting meant leaving the browser for a shell or the OS file manager. The upstream file tree (`ui-sidebar-files`) is read-only as well, and neither `ctx.fs` nor the `workspaceFiles` Remote carries a remove operation, so there was no existing capability to call.

## Decision

The panel's own host surface gains `POST /git/delete {cwd, path, recursive?}`. The host resolves the path against the request's workspace `cwd` with the same `resolveRepoPath` guard that `read`, `write`, and `list` use (no `..`, no absolute path, resolved under the workspace root), and then:

- refuses the workspace root itself;
- uses `lstat`, so a symlink is removed as the link it is rather than as its target;
- removes a file outright, and a directory only when the caller passes `recursive: true` — a non-empty directory without the flag is refused with a message naming the flag.

The panel renders one delete action per tree row. It opens a `Modal` (ui-primitives) that names the entry, and whose directory copy states that the contents go with it; only the confirm button sends the request. A successful delete re-reads the root and every expanded level, and drops the editor selection when the removed entry was the selected path or one of its ancestors.

## Alternatives considered

**Route deletion through `ctx.fs` and `workspaceFiles`.** Rejected for this change: neither carries a remove operation today, so that route means a new seam method, implementations in every provider (including the helper-backed `fs-ssh` wire), and a new Remote method — for a panel whose other operations already run on `/git/*`. If a model-facing tool or a second consumer needs deletion, the seam is the right home and the panel can switch to it then.

**A native `window.confirm`.** Rejected: the panel ships inside a styled Web app, the native prompt cannot carry the directory-contents wording, and it bypasses the locale dictionaries.

**Soft delete into a trash directory.** Rejected: the workspace has no trash concept, and a hidden `.trash` would surface in the file tree, in `git status`, and in the model's own file tools.

**Deleting through `git rm` or the commit flow.** Rejected: this panel also removes files that git does not track, and the user asked for a plain file operation rather than a staged deletion.

## Consequences

Deletion is permanent and immediate on disk: there is no undo, no trash, and no recovery path, which the package README records under its known limitations. Removing a directory takes its contents with it, gated only by the confirmation copy and the `recursive` flag. Like its `/git/read` and `/git/write` siblings, `/git/delete` sits outside the filesystem seam and the per-call sandbox policy: the guard is the workspace-relative path check, not the sandbox mode. A large directory removal is one synchronous request, so the panel shows nothing until it returns.

## Testing

- Host (`git-service.host.spec.ts`): file removal, refusal of a non-empty directory without `recursive`, recursive removal with contents, workspace-root refusal, and path-escape rejection.
- Client (`mutation-diff.client.spec.tsx`): the confirmation gates the request, cancelling sends nothing, a directory request carries `recursive: true`, and the tree re-reads its levels afterwards.
- Manual: the Web file panel opened the `deepseek-harness` workspace, deleted a scratch file under `tmp/`, and the listing dropped that row while its siblings stayed.
