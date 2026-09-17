/** Video metadata, keyed slot, dictionary, and disposal registration. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { VideoBody } from '../src/client/video/VideoBody.tsx'
import { apply, BINARY_VIDEO_EXTENSIONS, VIDEO_BODY_ID, VIDEO_EXTENSIONS, videoBodyDefinition } from '../src/client/video/index.ts'
import { en, zh } from '../src/client/video/locales.ts'

let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); dispose = undefined })

describe('video registration', () => {
  it('claims common video suffixes as a builtin complete-byte renderer without wrap', () => {
    const title = vi.fn(() => 'localized video')
    const definition = videoBodyDefinition(title)
    expect(definition).toEqual({
      id: VIDEO_BODY_ID,
      extensions: VIDEO_EXTENSIONS,
      binaryExtensions: BINARY_VIDEO_EXTENSIONS,
      priority: 'builtin',
      title,
      loading: 'bytes-complete',
      wrap: false,
    })
    expect(title).not.toHaveBeenCalled()
    expect(definition.title()).toBe('localized video')
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
    for (const extension of VIDEO_EXTENSIONS) {
      expect(registry.candidates(`CLIP.${extension}`).map(entry => entry.id)).toEqual([VIDEO_BODY_ID])
    }
    expect(registry.getSnapshot()[0]?.title()).toBe(en.title)
    expect(dictionaries.get('sidebarVideo')).toEqual({ zh, en })
    expect(register).toHaveBeenCalledExactlyOnceWith(
      { name: 'sidebar.right.tab.document', key: VIDEO_BODY_ID, locale: 'sidebarVideo' },
      VideoBody,
    )
    await dispose()
    expect(registry.getSnapshot()).toEqual([])
    expect(bodies.size).toBe(0)
    expect(dictionaries.size).toBe(0)
  })
})
