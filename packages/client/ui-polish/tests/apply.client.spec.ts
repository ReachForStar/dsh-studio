// @vitest-environment jsdom
/** ui-polish apply wiring: dictionaries, declaration-aware registrations, the
 * background row's inject → runtime → store projection, and teardown. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
// The apply surface registers the Excalidraw tab component, which statically
// imports the heavyweight whiteboard; this suite only exercises slot wiring,
// so stub the library (and its unexported stylesheet) before any import.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => null,
  exportToBlob: () => Promise.resolve(new Blob()),
}))
vi.mock('@excalidraw/excalidraw/dist/prod/index.css', () => ({}))
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
// The settings plugin's client entry re-exports the binder as a type only;
// mount its apply instead (the rc.8 binder is constructed inside it).
import {
  apply as settingsApply, inject as settingsInject,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS } from '@deepseek-ai/dsh-client-ui-polish/client'
import type { BackgroundRowInjected } from '@deepseek-ai/dsh-client-ui-polish/client'
import { BACKGROUND_SETTINGS_NAMESPACE, PolishSettingsSchema } from '../src/background-settings.ts'
import { BackgroundRow } from '../src/client/BackgroundRow.tsx'
import { CompactionRow } from '../src/client/CompactionRow.tsx'
import { PricingRow } from '../src/client/PricingRow.tsx'
import { StatsFloat } from '../src/client/StatsFloat.tsx'
import type { createBackgroundRowStore } from '../src/client/settings-store.ts'

const GENERAL = 'settings.general.item'
const DOCK = 'conversation.composer.dock'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  let backgroundImage: string | undefined
  const namespace = () => ({
    ns: BACKGROUND_SETTINGS_NAMESPACE,
    schema: PolishSettingsSchema.toJSON(),
    value: backgroundImage === undefined ? {} : { backgroundImage },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  })
  const describe = vi.fn(() => Promise.resolve({
    rpcId: 'polish-describe' as never,
    result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [namespace()] } },
  }))
  const mutate = vi.fn((request: { ops: { value: unknown }[] }) => {
    const raw = request.ops[0]!.value
    /* oxlint-disable-next-line typescript/no-base-to-string -- settings values are strings or null */
    backgroundImage = raw === null ? undefined : String(raw)
    return Promise.resolve({ rpcId: 'polish-mutate' as never, result: { ok: true as const, value: namespace() } })
  })
  ctx.provide('connection', { api: { settings: { describe, mutate } }, isLoopback: true } as never)
  new TestRemote(ctx)
  // The runtime plugin normally provides conversationEvents; stub its register
  // face (the ui-polish apply only subscribes a model-index definition).
  ctx.provide('conversationEvents', { register: () => () => {} } as never)
  // Mount the settings domain plugin (the rc.8 binder is a Service constructed
  // inside its apply, not a standalone plugin class).
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register(
    {
      name: 'root',
      children: {
        [GENERAL]: { kind: 'list', scope: 'root' },
        [DOCK]: { kind: 'list', scope: 'session' },
        'conversation.view': { kind: 'list', scope: 'session' },
      },
    } as never,
    () => null,
  )
  return { ctx, slots, locale }
}

afterEach(() => {
  document.head.querySelectorAll('style[data-ui-polish-ambient]').forEach((node) => { node.remove() })
  document.body.removeAttribute('data-ds-bg-image')
  document.body.removeAttribute('style')
})

describe('ui-polish apply', () => {
  it('declares the required services', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope', 'conversationEvents'])
  })

  it('registers the settings rows, dock entries, and view tabs, and unwinds on dispose', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries(GENERAL).map(e => e.options.id)).toEqual(['polish-background', 'polish-compaction', 'polish-pricing'])
    expect(b.slots.entries(DOCK).map(e => e.options.id)).toEqual(['polish-stats'])
    expect(b.slots.entries('conversation.view').map(e => e.options.id)).toEqual(['files', 'git', 'excalidraw'])
    expect(b.slots.entries(GENERAL).find(e => e.component === BackgroundRow)!.locale).toBe(NS)
    expect(b.slots.entries(GENERAL).find(e => e.component === CompactionRow)!.locale).toBe(NS)
    expect(b.slots.entries(GENERAL).find(e => e.component === PricingRow)!.locale).toBe(NS)
    expect(b.slots.entries(DOCK).find(e => e.component === StatsFloat)!.locale).toBe(NS)
    expect(document.head.querySelector('style[data-ui-polish-ambient]')).not.toBeNull()
    await fiber.dispose()
    expect(b.slots.entries(GENERAL)).toHaveLength(0)
    expect(b.slots.entries(DOCK)).toHaveLength(0)
    expect(document.head.querySelector('style[data-ui-polish-ambient]')).toBeNull()
  })

  it('the background row inject writes through the runtime and syncs the store', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries(GENERAL).find(e => e.component === BackgroundRow)!
    const handle = entry.store as ReturnType<typeof createBackgroundRowStore>
    const instance = handle.create()
    const face = (entry.inject as unknown as (a: typeof instance.actions) => BackgroundRowInjected)(instance.actions)
    face.setBackgroundImage('data:image/png;base64,QUJD')
    await vi.waitFor(() => { expect(instance.getSnapshot().backgroundImage).toBe('data:image/png;base64,QUJD') })
    await fiber.dispose()
    expect(document.body.hasAttribute('data-ds-bg-image')).toBe(false)
  })
})
