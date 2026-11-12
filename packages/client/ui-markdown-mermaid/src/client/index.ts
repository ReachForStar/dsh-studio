/**
 * Chat Markdown Mermaid plugin, browser half: the `mermaid` layer of the
 * Chat-owned `conversation.chat.markdown.fence` slot. The layer draws a
 * settled fence and keeps the owner's code block while the fence streams or
 * after a drawing failure. Mermaid itself is a dynamic chunk of this package's
 * browser bundle, requested at the first settled fence, so chat boot pays
 * nothing for it. Export discipline: packages/client/AGENTS.md.
 * @module @deepseek-ai/dsh-client-ui-markdown-mermaid/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Chat fence declaration and its owner props.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MermaidFenceLayer } from './MermaidFenceLayer.tsx'
import { createMermaidRenderer } from './mermaid.ts'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'mermaid'

/** Required services: the slot registry and copy. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the `mermaid` dictionaries and the language
 * layer that draws settled `mermaid` fences.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-markdown-mermaid: dictionaries')
  // One library load and one id sequence per plugin instance: both are the
  // plugin's own, reachable by the layer only through this inject face.
  const renderDiagram = createMermaidRenderer()
  let diagrams = 0
  const nextDiagramId = (): string => `mermaid-diagram-${++diagrams}`
  ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register({
    name: 'conversation.chat.markdown.fence',
    key: 'mermaid',
    id: '@deepseek-ai/dsh-client-ui-markdown-mermaid/fence/mermaid',
    locale: NS,
    inject: () => ({ renderDiagram, nextDiagramId }),
  }, MermaidFenceLayer))
}
