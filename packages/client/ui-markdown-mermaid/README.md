---
description: "Chat Mermaid fences in the dsh web client: the drawn diagram after a reply settles, the source block while it streams or when drawing fails, and the exact drawing pipeline the layer uses."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-markdown-mermaid

English | [中文](README.zh.md)

## Summary

Chat replies that carry a `mermaid` code fence can show the diagram instead of the code. A settled fence is drawn in place of its code block; a fence that is still streaming, or whose body Mermaid rejects, keeps the source block so the reply stays readable. Drawing happens entirely in the browser, from this package's own lazily loaded Mermaid chunk: no host call, and no change to the model's reply. Mount it alongside `ui-chat`; without it every fence renders as a code block.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the same composition as `ui-chat`; Chat's Markdown fences then dispatch to it by language, and every other language keeps its code block. The plugin has no configuration and no commands.

### What the reader sees

A `mermaid` fence whose surrounding reply has settled is drawn as a diagram, centered in the message column and scrolled horizontally when it is wider than the column. While the reply streams, the same fence stays a code block, so a half-written diagram never draws as a syntax error; the drawing appears once the fence settles. A body Mermaid rejects shows the code block again, with a note that the diagram could not be drawn, so the source remains readable. Fences in any other language are untouched: this package occupies only the `mermaid` language of the fence slot.

### When to choose it

Include it whenever the Web bundle's chat should render diagrams; omit it to keep every fence as source, for example in a composition that never loads the Mermaid chunk. There is no per-Session or per-reply switch: the drawing decision is the fence language plus whether the reply has settled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half registers one layer into Chat's `conversation.chat.markdown.fence` HOC slot with `key: 'mermaid'`, so Chat's `entryKey` dispatch selects it for `mermaid` fences only and renders the owner's plain code block for every other language. `apply` creates one renderer and one id sequence per plugin instance and hands both to the layer through the slot's inject face; the layer therefore never reaches for a module-level library handle.

The layer renders the owner's `FenceCodeBlock` directly while `streaming` is true and passes it down as the drawing's fallback otherwise. One drawing component owns three states — drawing, drawn, failed — each tagged with the fence body it describes; a render-phase state reset discards the result of a body that has since changed, an effect cleanup abandons a drawing whose component unloaded, and the renderer receives a `mermaid-diagram-<n>` id minted per drawing.

The renderer loads `mermaid` through a dynamic `import()` at the first settled fence, so the library lives in `lib/client.*.js` chunks that the browser fetches on demand rather than at chat boot. The first load initializes the library once with `startOnLoad: false`, `securityLevel: 'strict'`, and `suppressErrorRendering: true`; strict mode encodes embedded HTML and drops click handlers before mermaid sanitizes the serialized SVG, and suppressed error rendering makes an invalid body reject instead of drawing mermaid's own error picture, which is what reaches the code-block fallback. The returned SVG is inserted as markup, exactly as mermaid's render contract requires.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the package draws fence bodies the model already wrote; it registers no prompt, tool, or result that reaches a model request.

#### KV Cache effect

None; the drawing is browser presentation and leaves the model-visible history and its cached prefix unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Mermaid's theme, not the app theme** — diagram colors come from mermaid's default theme, so a diagram inside a dark page is drawn light. Binding the diagram palette to the `--dsw-*` tokens would require re-initializing the library on every theme change.
- **No pan, zoom, or fullscreen** — a diagram wider than the message column scrolls horizontally; there is no viewer, so a large diagram is read at its drawn size.
- **First drawing pays for the library** — the Mermaid chunk loads at the first settled fence, so that drawing can appear after the reply's text; later diagrams reuse the same load.
- **One private copy per bundle** — a second package that embeds Mermaid, such as the Excalidraw panel, ships its own copy; the two do not share a module-table row.
- **Only the `mermaid` language** — aliases such as `mmd` stay code blocks, because the slot dispatch key is the fence language word itself.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None; the layer's only hidden state is the injected renderer and id sequence, and both are created and owned by `apply`.

</details>
