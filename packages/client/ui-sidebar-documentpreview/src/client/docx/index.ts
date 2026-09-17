/** Builtin Word metadata and keyed document-body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { DocxBody } from './DocxBody.tsx'
import { en, zh } from './locales.ts'

/** Word implementation identity, shared by metadata and the keyed slot. */
export const DOCX_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/docx'

/** File suffixes rendered by the builtin Word body. */
export const DOCX_EXTENSIONS = ['docx'] as const

/** Word suffixes whose bytes are unreadable as text. */
export const BINARY_DOCX_EXTENSIONS = ['docx'] as const

/**
 * Describe the builtin Word renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns metadata for complete Word documents.
 */
export function docxBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return {
    id: DOCX_BODY_ID,
    extensions: DOCX_EXTENSIONS,
    binaryExtensions: BINARY_DOCX_EXTENSIONS,
    priority: 'builtin',
    title,
    loading: 'bytes-complete',
    wrap: false,
  }
}

/**
 * Register the Word dictionary, metadata, and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarDocx')
  ctx.effect(() => ctx.locale.register('sidebarDocx', { zh, en }), 'document-docx: dictionaries')
  ctx.effect(() => ctx.documentPreviews.register(docxBodyDefinition(() => t('title'))), 'document-docx: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: DOCX_BODY_ID, locale: 'sidebarDocx' }, DocxBody,
  )), 'document-docx: body')
}
