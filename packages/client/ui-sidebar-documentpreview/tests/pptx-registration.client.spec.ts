/** PowerPoint metadata, keyed slot, dictionary, and disposal registration. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { PptxBody } from '../src/client/pptx/PptxBody.tsx'
import { apply, BINARY_PPTX_EXTENSIONS, PPTX_BODY_ID, PPTX_EXTENSIONS, pptxBodyDefinition } from '../src/client/pptx/index.ts'
import { en, zh } from '../src/client/pptx/locales.ts'

let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); dispose = undefined })

describe('pptx registration', () => {
  it('claims .docx as a builtin complete-byte renderer without wrap', () => {
    const title = vi.fn(() => 'localized powerpoint')
    const definition = pptxBodyDefinition(title)
    expect(definition).toEqual({
      id: PPTX_BODY_ID,
      extensions: PPTX_EXTENSIONS,
      binaryExtensions: BINARY_PPTX_EXTENSIONS,
      priority: 'builtin',
      title,
      loading: 'bytes-complete',
      wrap: false,
    })
    expect(title).not.toHaveBeenCalled()
    expect(definition.title()).toBe('localized powerpoint')
  })

  it('registers its dictionary and matching keyed body, then removes every contribution', async () => {
    const ctx = new Context()
    const registry = new DocumentPreviewRegistry()
    const dictionaries = new Map<string, unknown>()
    const bodies = new Map<string, unknown>()
    const register = vi.fn((options: { key: string }, body: unknown) => {
      bodies.set(options.key, body)
      return () => { bodies.delete(options.key) }
    })
    ctx.provide('documentPreviews', registry)
    ctx.provide('slots', { inject: (_key: string, callback: () => () => void) => callback(), register } as never)
    ctx.provide('locale', {
      bind: () => (key: keyof typeof en) => en[key],
      register: (name: string, value: unknown) => {
        dictionaries.set(name, value)
        return () => { dictionaries.delete(name) }
      },
    } as never)
    const fiber = ctx.plugin({ apply })
    dispose = async () => { await fiber.dispose() }
    await fiber.await()
    expect(registry.candidates('deck.pptx').map(entry => entry.id)).toEqual([PPTX_BODY_ID])
    expect(registry.getSnapshot()[0]?.title()).toBe(en.title)
    expect(dictionaries.get('sidebarPptx')).toEqual({ zh, en })
    expect(register).toHaveBeenCalledExactlyOnceWith(
      { name: 'sidebar.right.tab.document', key: PPTX_BODY_ID, locale: 'sidebarPptx' },
      PptxBody,
    )
    await dispose()
    expect(registry.getSnapshot()).toEqual([])
    expect(bodies.size).toBe(0)
    expect(dictionaries.size).toBe(0)
  })
})
