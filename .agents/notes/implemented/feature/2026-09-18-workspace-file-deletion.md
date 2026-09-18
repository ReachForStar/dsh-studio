# Agent Note: Deleting workspace files from the sidebar tree

Status: implemented

English | [中文](2026-09-18-workspace-file-deletion.zh.md)

## Problem

The right-sidebar Files tree could browse a workspace but never remove anything from it: `ctx.fs` had no removal primitive, `workspaceFiles` exposed no deletion endpoint, and the tree drew rows with no action but open. The only delete affordance the fork ever had lived in its own `conversation.view` file tab (`ui-polish`'s `MutationDiffPanel`), which was removed one commit earlier as a duplicate of this tree — so deleting an entry meant leaving the browser for a terminal or `git rm`.

Removal is also the one filesystem mutation that must NOT be addressed by a resolved target. `resolve()` follows the final symlink, so a target names what a path points at; deleting through it would delete the link's destination rather than the link. Every existing mutation on the seam (`writeText`, `writeBytes`, `editText`) takes a target, so the primitive had to break that shape deliberately.

## Decision

`ctx.fs.remove(path, opts?, signal?, sandboxPolicy?)` joins the seam, addressed by PATH with `lstat` semantics: a symbolic link is removed as the link it is, a directory goes with its contents only under `recursive`, a non-empty directory without it fails with a new `FS_NOT_EMPTY` code, and the outcome reports what the entry was (`file` | `directory` | `symlink` | `other`). It carries no version guard: a removal is stated as a path rather than derived from content, so a file that changed since the caller looked is still the file it named.

Every provider implements it, because the seam is abstract and the deployments differ: `fs-local` removes through `removePath` in `fsio.ts`, `fs-sandbox` fences the removal by the per-call policy, `fs-ssh` sends a new `fs.remove` helper operation, and the fork's `fs-sftp` removes over the SFTP surface.

`fs-sandbox` fences the PARENT's canonical path, not the entry's: the entry may be a symbolic link, and resolving it first would fence (and then delete) the wrong path. A symlinked ancestor still realpaths into that check, and `rm` never follows a link inside a removed tree, so the fence covers the escape it exists for.

`workspaceFiles.delete(scope, path, { recursive }, signal)` is the Remote endpoint the browser calls. It inspects the entry with `lstat`, proves containment on the entry's parent, delegates to `ctx.fs.remove`, and maps the backend's `FS_NOT_EMPTY` refusal onto the wire vocabulary as `workspace-file/not-empty`. It is named `delete` rather than `remove` because the client's namespace service owns `remove` for its own mount lifecycle and rejects a remote method that shadows it (`client api: method "workspaceFiles/remove" conflicts with its namespace service`), which fails the whole client plugin at boot.

The Files tree gains a per-row delete control and a confirmation dialog: the dialog names the entry, says for a directory that its contents go with it, and only a confirmation calls the endpoint. Nothing leaves the tree until the Host answers; on success the row and its subtree (cached levels and expansion) drop together and the parent level is re-listed, and on failure the dialog stays open with the mapped reason.

## Alternatives considered

**Soft delete into a trash directory.** Rejected while designing the removed panel and again here: a `.trash` inside the workspace pollutes the tree, the model's view, and `git status`, and a remote SFTP workspace has no platform trash to defer to. Deletion is permanent and the confirmation says so.

**Route deletion through the `/git/*` host routes**, as the removed panel did. Rejected: those routes exist only in the Web host composition and resolve paths with `node:fs`, so they cannot serve a workspace whose `ctx.fs` is a remote provider — exactly the deployments this fork added. The seam is the only home that reaches every provider.

**Address removal by target, like every other mutation.** Rejected: a resolved target cannot name a symbolic link, so links (and dangling links) would be undeletable at best and dangerous at worst.

**Implement removal only in the local provider and refuse elsewhere.** Rejected: `FileSystem.remove` is abstract, so every backend must answer; a text-only or remote backend that cannot remove should say so, not inherit the local behavior. `writeBytes` is the precedent for a *base* refusal, and removal has no such "channel cannot carry it" case.

**Rename the client namespace service's `remove` lifecycle method to free the name.** Considered and rejected: the collision lives in upstream client runtime shared by every namespace, and renaming it there means diverging from upstream for the sake of one method name. `delete` costs nothing on the wire and matches the vocabulary the UI already uses.

## Consequences

Deletion is permanent: no trash, no undo, and a directory takes its contents with it. That is stated in the confirmation, in the package README, and here.

The fork now patches an upstream browser package (`ui-sidebar-files`) rather than only adding packages, so upstream merges of that package need the delete action carried along. The alternative — a second file surface owned by the fork — is the duplication this tree replaced.

Model-visible behavior is unchanged: no tool exposes removal, so nothing reaches a model request and no session event was added.

## Testing

- Seam and providers: `fs-local` removes files, links (keeping the target), empty directories and trees, refuses a non-empty directory without `recursive`, reports missing entries and aborts; `fs-sandbox` denies under `read-only`, contains under `workspace-write` (including through a link that leaves the workspace), removes the link itself, and resolves relative paths against `opts.cwd` and the configured base.
- Wire: `fs-ssh` forwards the base directory, the recursive flag and the policy and keeps the helper's error codes; the SSH helper serves `fs.remove` with the negotiated workspace; `fs-sftp` removes over a real in-process SFTP server, refuses a non-empty directory without `recursive`, and fences outside the writable roots.
- Remote endpoint: `workspaceFiles.delete` removes files, empty directories and trees, deletes a link as the link, refuses the workspace root and paths outside it (including through a link that leaves it), maps `FS_NOT_EMPTY`, and propagates any other backend refusal unchanged.
- UI: the tree sends nothing until the dialog is confirmed, passes `recursive` for a directory only, drops the row and its subtree on success, re-lists the parent, keeps the dialog open with the mapped reason on failure, and closes from either control without a call.
- Manual: `dsh web` → right sidebar → 工作区文件 → `tmp/del-demo`: deleting `doomed.txt` left `keep.txt` and removed the file from disk, and deleting `sub` (a directory holding `nested.txt`) removed both.
