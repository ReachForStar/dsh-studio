# Agent Note: Edit a workspace file from the document preview

Status: implemented

English | [中文](2026-09-17-workspace-file-editing.zh.md)

## Problem

The document preview reads files through `workspaceFiles` and had no way to write one back: the service exposed `read`, `readBytes`, `readAll`, `readRelated`, `stat`, `list`, and `changes`, and its module doc said so explicitly ("this service exposes no mutations"). Editing a file therefore meant leaving the panel for a terminal or a model tool call, even though the panel already held the file's content and its version.

## Decision

`workspaceFiles` gains `write(scope, path, text, guard, signal)`, and the text-mode viewers of `ui-sidebar-documentpreview` gain an editor over it.

The write reuses the service's existing gates and adds two of its own. `locateWritable` is `locateFile` plus containment: reads may follow a path outside the workspace (a preview of a file the workspace does not own is still a preview), while a write stays inside it. The version the editor read travels as `expectedVersion` and becomes the filesystem seam's `replaceIfVersion` intent, so a file that changed underneath fails with `workspace-file/stale-version` instead of being overwritten; the backend's `FS_STALE_VERSION` is recognized by code, like the existing non-text refusal, because the error class belongs to whichever `dsh-fs` instance the provider loaded. The `maxFileBytes` cap applies to the new content, and `fs.writeText` replaces the file atomically.

On the client, the editor lives in the pane rather than in each body renderer, so one control covers plain text, code, and Markdown. Opening it first reads the remaining pages: a draft taken from a loaded prefix would truncate the file, and the save replaces the whole content. A save carries `current.version` and, once committed, moves the tab's held and observed versions to the reported one, so the panel's change bar does not report the reader's own write as an external change. The face keeps the same settlement rule as a read: a write whose tab ended, or whose read generation moved on, writes nothing.

## Alternatives considered

**Put the editor in each text renderer.** Three implementations of one save path, three places to keep the version guard correct, and Markdown would need its own answer for the same file.

**Save only when the whole file fits one read.** The panel reads pages precisely because a file may exceed the page cap; refusing to edit a large file would be a product limit invented by the transport.

**Trust the read and write unconditionally.** Without `expectedVersion` a save silently discards a model edit, a tool write, or another window's save that landed after the read — the one failure this panel cannot reconstruct.

**Write bytes through the same endpoint.** Not needed for text, and the filesystem seam has no binary write: docx/pptx editing (zipped OOXML) has to add one, which is deferred rather than smuggled in through base64 in a text call.

## Consequences

A text file in the Session's workspace can be edited where it is read, with a refusal that explains itself instead of a silent overwrite. Byte-mode viewers (PDF, HTML, images) and binary formats stay read-only; the editor is plain text, so there is no syntax-aware editing, and the endpoint offers no create, rename, or delete. Coverage of the fork's client editing path comes from the pane's own specs (draft initialisation, incomplete-file read, refusal, shortcut, second-save guard) and the face's write specs.
