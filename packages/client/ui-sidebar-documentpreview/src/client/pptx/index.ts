/** Builtin PowerPoint metadata and keyed document-body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { PptxBody } from './PptxBody.tsx'
import { en, zh } from './locales.ts'

/** PowerPoint implementation identity, shared by metadata and the keyed slot. */
export const PPTX_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pptx'

/** File suffixes rendered by the builtin PowerPoint body. */
export const PPTX_EXTENSIONS = ['pptx'] as const

/** PowerPoint suffixes whose bytes are unreadable as text. */
export const BINARY_PPTX_EXTENSIONS = ['pptx'] as const

/**
 * Describe the builtin PowerPoint renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns metadata for complete presentations.
 */
export function pptxBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return {
    id: PPTX_BODY_ID,
    extensions: PPTX_EXTENSIONS,
    binaryExtensions: BINARY_PPTX_EXTENSIONS,
    priority: 'builtin',
    title,
    loading: 'bytes-complete',
    wrap: false,
  }
}

/**
 * Register the PowerPoint dictionary, metadata, and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarPptx')
  ctx.effect(() => ctx.locale.register('sidebarPptx', { zh, en }), 'document-pptx: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(pptxBodyDefinition(() => t('title'))), 'document-pptx: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: PPTX_BODY_ID, locale: 'sidebarPptx' }, PptxBody,
  )), 'document-pptx: body')
}
