# Agent Note: Remove the duplicate file panel

Status: implemented

English | [中文](2026-09-18-remove-duplicate-file-panel.zh.md)

## Problem

The Web GUI offered two ways to browse the same workspace files: the built-in right-sidebar Files tree (`ui-sidebar-files`, the upstream document panel's companion) and `ui-polish`'s own `conversation.view` tab titled "文件" — its `MutationDiffPanel` rendered a second directory tree from the host's `/git/list` route and duplicated the same file browsing, plus an extra editor on top of the pane the document panel already provides. Two entry points for one job split attention, doubled the surface to maintain, and made every file-facing change land twice.

## Decision

The file tab is gone. `ui-polish` no longer registers a `conversation.view` entry with id `files`, and `MutationDiffPanel` and its stylesheet are deleted. The host routes that existed only for it are gone with it: `/git/list` (the tree's lazy listing) and `/git/delete` (the permanent-delete action added the same day). `/git/read` and `/git/write` stay, because the Git panel's inline editor uses them.

File browsing and preview therefore live where they already existed: the right-sidebar Files tree for the tree, and the document preview pane for opening, previewing, and editing a file. The package README records the deliberate absence, and its feature list, route table, and slot table no longer mention the tab.

## Alternatives considered

**Keep the tab and delete the right-sidebar tree.** Rejected: the right-sidebar tree belongs to the upstream document panel (`ui-sidebar-files` plus `ui-sidebar-documentpreview`), which this fork keeps in step with upstream; removing it would mean diverging from upstream layout for a fork-only panel.

**Keep both, but make the tab read-only.** Rejected: the duplication itself is the cost — the second tree still needs the listing route, i18n, tests, and maintenance.

**Keep the tab and drop its editor.** Rejected for the same reason, and the editor was not the part being requested anyway.

**Port the delete capability to the surviving tree before removing the tab.** Deferred, not rejected: the right-sidebar tree and the `workspaceFiles` Remote carry no remove operation, so porting means a new `ctx.fs` method, implementations in every filesystem provider (including the helper-backed `fs-ssh` wire), and a new Remote method. That is a capability decision of its own, not a by-product of deleting a duplicate panel.

## Consequences

One file surface remains, and the fork's client bundle loses the second tree, its editor, and the `/git/list` and `/git/delete` handlers with their tests. Deletion through the Web GUI has no replacement today: the permanent-delete action added earlier the same day was reachable only from the removed panel, so it was removed with it rather than left registered on a route nothing calls. Git remains the only `ui-polish` tab that edits files, and it edits only files git already tracks or shows as changed.

## Testing

- `ui-polish` tests pass with the panel's suite deleted and the route tests trimmed to the surviving endpoints; the slot-registration test now asserts the `conversation.view` ids are `git`, `excalidraw`, and `ssh`.
- Manual: the Web GUI's top tab ring shows 对话 / 轨迹 / Git / 画布 / SSH with no 文件 tab, and the right-sidebar Files tree still browses the workspace.
