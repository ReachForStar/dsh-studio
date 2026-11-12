/**
 * Lazy Mermaid renderer for the chat fence layer. The library stays a dynamic
 * browser chunk: importing it eagerly would put every diagram engine in front
 * of the first chat render.
 */
import type { Mermaid } from 'mermaid'

/** Draws one fence body to an SVG string; rejects on invalid source. */
export type MermaidRender = (id: string, code: string) => Promise<string>

/**
 * Create one renderer bound to this plugin instance. The library load is
 * shared by every diagram of the instance and starts at the first settled fence.
 * @returns the renderer the fence layer calls with a fresh element id.
 */
export function createMermaidRenderer(): MermaidRender {
  let library: Promise<Mermaid> | undefined
  const load = (): Promise<Mermaid> => {
    library ??= import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        // Diagram source is assistant output: strict encodes embedded HTML,
        // drops click handlers, and sanitizes the serialized SVG.
        securityLevel: 'strict',
        // Without this mermaid draws its own error picture for invalid source
        // instead of rejecting, which would hide the code-block fallback.
        suppressErrorRendering: true,
      })
      return mermaid
    })
    return library
  }
  return async (id, code) => (await (await load()).render(id, code)).svg
}
