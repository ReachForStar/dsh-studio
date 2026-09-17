# Agent Note: Edit Word and PowerPoint documents where they are previewed

Status: implemented

English | [中文](2026-09-17-office-document-editing.zh.md)

## Problem

The preview's text editor covers files the browser can hold as text, and the byte-writing endpoint added with it (`workspaceFiles.write`) is text too. An office document is neither: a `.docx` or `.pptx` is a zip of XML parts, so showing one needs the archive unpacked and saving one needs the archive written back. Nothing in the harness could write binary content to a file: the filesystem seam exposed `writeText` and `editText` only.

## Decision

The filesystem seam gains `writeBytes`, and the document preview gains two renderers over it.

`FileSystem.writeBytes` is a **concrete** method on the Service Definition that refuses with `FS_UNSUPPORTED_BINARY_WRITE`, not a third abstract mutation. A backend that cannot carry bytes — a filesystem reached over a channel that encodes text — then says so at the call, and every existing provider keeps compiling without a new obligation it does not meet. `LocalFileSystem` overrides it (its atomic writer now accepts `string | Uint8Array`), `SandboxedFileSystem` fences it with the same per-call policy as `writeText`, and `SshFileSystem` inherits the refusal while listing the code as transportable. `workspaceFiles.writeBytes` carries base64 bytes under the same guards as `write`: workspace containment, the `maxFileBytes` cap, and the version the editor read, mapping a refusal to `workspace-file/binary-unsupported`.

The two renderers are one shape with two parsers. `parseDocx` reads `word/document.xml` into paragraph strings and returns a `rebuild` that closes over the parts it unpacked, so the editor can only write back a document that still contains everything the reader did not understand; `parsePptx` does the same per `ppt/slides/slideN.xml`, in numeric slide order. Both parsers match XML by **local name**, ignoring the prefixes a producer chose, and an edit keeps the existing leaf elements — the first takes the new text, the rest are emptied — so the run formatting and the shape holding it survive. `fflate` (already a workspace dependency) does the zip; nothing here hand-rolls DEFLATE. The shared `OfficeBody` chrome renders either shape and owns no save state: the pane already tracks the write through the tab's store, so `saving` and `saveFailure` arrive as props and the failure line is the same `failureLine` the text editor uses.

## Alternatives considered

**Add `writeBytes` as a third abstract method.** Every provider and every test fake must implement it, including the ones that cannot: the compiler would demand a lie from a text-only backend.

**Write the archive through the text endpoint.** Base64 in a text field is not the file, and a mis-encoded write produces a corrupt document with no error anywhere.

**Rewrite the whole OOXML part from a parsed model.** Serializing a model means choosing what to preserve: styles, numbering, fields, comments, and revision marks would silently disappear from a document the user only wanted to reword.

**Put each format's editor in its own component.** Two copies of the draft/baseline/save-status logic, and the office failure paths would drift from the text editor's.

## Consequences

Word paragraphs and PowerPoint text leaves are editable in the preview, with the rest of the document preserved by construction; formats the parsers do not understand (`.doc`, `.ppt`, and any archive without the expected parts) still report that they cannot be opened. Binary writes are unavailable on an SSH-channel filesystem, which refuses loudly instead of corrupting the file. Editing is text-level: layout, tables, images, and new shapes are out of scope, and both renderers are covered by parser, chrome, and registration specs.
