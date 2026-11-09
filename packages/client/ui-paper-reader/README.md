---
description: "Right-Sidebar paper reader: uploaded PDFs in their original layout, text highlights with notes, and questions that fill the composer draft."
kind: "package-reference"
---

# @reachforstar/dsh-client-ui-paper-reader

English | [中文](README.zh.md)

## Summary

Use this package to read uploaded papers inside a right-Sidebar tab. The browser half lists the stored library, renders each PDF page with PDF.js onto a canvas plus a selectable text layer, and opens a floating menu on a text selection with highlight, note, and ask actions. The Host half stores PDFs and their annotations under the web profile directory and serves them over `/paper-reader`. The package registers one tab type and reads no Sidebar store.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in a Web composition whose Host can write the profile directory. The tab appears in the right Sidebar guide; opening it lists the papers already uploaded, and uploading a PDF opens it at once.

### Minimal configuration

```yaml
- id: ui-paper-reader
  name: '@reachforstar/dsh-client-ui-paper-reader'
```

The browser half requires the `slots`, `locale`, `sidebarRightTabs`, `sessions`, and `conversation` services; the Host half requires `webServer`. Papers and their annotation documents live under `~/.dsh/profiles/web/papers/`, named `<id>.pdf` and `<id>.json`.

<a id="model-experience"></a>
## Model Experience

None, as the ask action only fills the unsent composer draft and never submits it.

#### KV Cache effect

No direct effect; the draft enters a model request only when the user submits it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A highlight stores page-relative rectangles taken from the browser's selection boxes, so a selection that crosses a page boundary is not offered the menu.
- The reader has no search, table of contents, or page-jump control; it draws every page in one scrolling column and rasterizes a page once it nears the viewport.
- Uploading never merges entries: uploading the same file twice creates two library entries, and deleting an entry removes its annotations with it.
- The annotation document is rewritten whole on every change, so two browser tabs editing one paper overwrite each other's list.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
