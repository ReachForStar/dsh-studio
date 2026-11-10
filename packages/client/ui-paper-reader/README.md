---
description: "Right-Sidebar paper reader: uploaded PDFs in their original layout, text highlights with notes, and questions that fill the composer draft."
kind: "package-reference"
---

# @reachforstar/dsh-client-ui-paper-reader

English | [中文](README.zh.md)

## Summary

Use this package to read uploaded papers inside a right-Sidebar tab. The browser half lists the stored library, renders each PDF page with PDF.js onto a canvas plus a selectable text layer, and opens a floating menu on a text selection with highlight, note, ask, and translate actions. A selection or the whole document translates into Chinese or English, streaming into a closable, copyable card. The Host half stores PDFs and annotations under the web profile directory, serves them over `/paper-reader`, and streams translation deltas over `/paper-reader/translate`. The package registers one tab type and reads no Sidebar store.

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

The browser half requires the `slots`, `locale`, `sidebarRightTabs`, `sessions`, and `conversation` services; the Host half requires `webServer`, and the translate route additionally waits for `llm`. Papers and their annotation documents live under `~/.dsh/profiles/web/papers/`, named `<id>.pdf` and `<id>.json`.

### Translation

A selection menu translation posts the selected text; the toolbar's full-text action extracts each page's text with PDF.js, skips pages without text, and submits the remaining pages in order. Both use one zero-temperature request per submission through the first LLM route that produces text, and the target defaults to Chinese when the interface language is Chinese and English otherwise; the card can switch between the two. The route answers NDJSON — `delta` lines, then `finish`; a failure before the first delta is a JSON error response, and a failure after it is an `error` line. Nothing about the translation enters the Session log.

<a id="model-experience"></a>
## Model Experience

None, as the ask action only fills the unsent composer draft, and translation requests stream an answer into the reader card without contributing Session context or a logged message.

#### KV Cache effect

Translation requests repeat one fixed short system prompt per target language, so a provider can reuse that prefix; the submitted page or selection text follows it and differs per request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A highlight stores page-relative rectangles taken from the browser's selection boxes, so a selection that crosses a page boundary is not offered the menu.
- The reader has no search, table of contents, or page-jump control; it draws every page in one scrolling column and rasterizes a page once it nears the viewport.
- Uploading never merges entries: uploading the same file twice creates two library entries, and deleting an entry removes its annotations with it.
- The annotation document is rewritten whole on every change, so two browser tabs editing one paper overwrite each other's list.
- Translation needs a composed `llm` service; without one the library still serves, but the translate route is not registered.
- A full-text translation submits one request per page with text, so a long paper issues one model call per page.
- Only Chinese and English are offered as translation targets; every other interface language starts in English.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
