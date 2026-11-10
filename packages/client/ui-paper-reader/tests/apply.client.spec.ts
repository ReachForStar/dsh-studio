// @vitest-environment jsdom
/**
 * The plugin's registrations, and their removal when the plugin goes.
 *
 * The tab registry is real, because "registered" means what it says a tab type
 * is; the slot and locale faces are recorders, because what matters here is
 * what was handed to them and that every registration is gone after dispose.
 */
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { PAPER_READER_ID, PAPER_READER_KIND, paperReaderDefinition } from '../src/client/definition.ts'
import { apply, inject } from '../src/client/index.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { PaperReaderTab } from '../src/client/PaperReader.tsx'

interface Recorded {
  readonly name: string
  readonly key: string
  readonly locale?: string
  readonly inject?: () => unknown
  readonly component: unknown
}

async function boot() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    bind: (namespace: string) => (key: string) => `${namespace}.${key}`,
    register: vi.fn((namespace: string, dicts: unknown) => {
      dictionaries.set(namespace, dicts)
      return () => { dictionaries.delete(namespace) }
    }),
  }
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  return { ctx, tabs, registered, dictionaries, fiber }
}

describe('ui-paper-reader apply', () => {
  it('registers the tab type, its dictionaries, and its page under the type id', async () => {
    const { tabs, registered, dictionaries, ctx } = await boot()
    const definition = tabs.get(PAPER_READER_KIND)
    expect(definition?.id).toBe(PAPER_READER_ID)
    expect(definition?.priority).toBe('builtin')
    expect(dictionaries.get('paperReader')).toEqual({ zh, en, ja, es, fr, de, ru, pt })
    const entry = registered[0] as Recorded
    expect(entry).toMatchObject({
      name: 'sidebar.right.pane.tab', key: PAPER_READER_ID, locale: 'paperReader', component: PaperReaderTab,
    })
    // The page reads the active interface language for its first translation target.
    expect(entry.inject?.()).toEqual({ hooks: { language: ctx.locale } })
  })

  it('takes every registration back when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(PAPER_READER_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})

describe('paperReaderDefinition', () => {
  it('reads its labels from the bound dictionary on every call', () => {
    const keys: string[] = []
    const definition = paperReaderDefinition((key) => { keys.push(key); return key })
    expect(definition.title('')).toBe('tabTitle')
    expect(definition.guide?.map(entry => [entry.id, entry.order, entry.title(), entry.description?.()])).toEqual([
      ['library', 5, 'guideTitle', 'guideDescription'],
    ])
    expect(keys).toEqual(['tabTitle', 'guideTitle', 'guideDescription'])
  })
})
