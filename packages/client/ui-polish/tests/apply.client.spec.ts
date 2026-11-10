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
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import {
  apply as settingsApply, inject as settingsInject,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS } from '@reachforstar/dsh-client-ui-polish/client'
import type { BackgroundRowInjected } from '@reachforstar/dsh-client-ui-polish/client'
import { BACKGROUND_SETTINGS_NAMESPACE, PolishSettingsSchema } from '../src/background-settings.ts'
import { BackgroundRow } from '../src/client/BackgroundRow.tsx'
import { BudgetRow } from '../src/client/BudgetRow.tsx'
import { CompactionRow, type CompactionRowInjected } from '../src/client/CompactionRow.tsx'
import { PricingRow, type PricingRowInjected } from '../src/client/PricingRow.tsx'
import { SshPanel, type SshPanelInjected } from '../src/client/SshPanel.tsx'
import { StatsFloat } from '../src/client/StatsFloat.tsx'
import { ExcalidrawToolView } from '../src/client/ExcalidrawToolView.tsx'
import type {
  createBackgroundRowStore, createBudgetRowStore, createCompactionRowStore, createPricingRowStore,
} from '../src/client/settings-store.ts'

const GENERAL = 'settings.general.item'
const DOCK = 'conversation.composer.dock'

async function bench(initial: { modelPricing?: string } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  let backgroundImage: string | undefined
  let monthlyBudget: number | undefined
  let compactionRatio: number | undefined
  let modelPricing: string | undefined = initial.modelPricing
  const namespace = () => ({
    ns: BACKGROUND_SETTINGS_NAMESPACE,
    schema: PolishSettingsSchema.toJSON(),
    value: {
      ...(backgroundImage === undefined ? {} : { backgroundImage }),
      ...(monthlyBudget === undefined ? {} : { monthlyBudget }),
      ...(compactionRatio === undefined ? {} : { compactionThresholdRatio: compactionRatio }),
      ...(modelPricing === undefined ? {} : { modelPricing }),
    },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  })
  const describe = vi.fn(async () => ({
    ok: true as const,
    value: { writable: true, hasDocument: true, namespaces: [namespace()] },
  }))
  const mutate = vi.fn(async (_ns: string, ops: { op: string; path: string[]; value?: string | number | null }[]) => {
    const operation = ops[0]!
    const raw = operation.value
    const absent = raw === undefined || raw === null
    if (operation.path[0] === 'monthlyBudget') {
      monthlyBudget = absent ? undefined : Number(raw)
    } else if (operation.path[0] === 'compactionThresholdRatio') {
      compactionRatio = absent ? undefined : Number(raw)
    } else if (operation.path[0] === 'modelPricing') {
      modelPricing = absent ? undefined : String(raw)
    } else {
      backgroundImage = absent ? undefined : String(raw)
    }
    return { ok: true as const, value: namespace() }
  })
  const sshOk = () => vi.fn(async () => ({ ok: true as const, value: {} }))
  const ssh = {
    list: vi.fn(async () => ({ ok: true as const, value: { connections: [] } })),
    save: sshOk(),
    delete: sshOk(),
    test: sshOk(),
    exec: sshOk(),
    ptyOpen: sshOk(),
    ptyAttach: sshOk(),
    // One denied call proves the error mapping the panel reads.
    ptyWrite: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'E_DENIED', message: 'nope' },
    })),
    ptyResize: sshOk(),
    ptyClose: sshOk(),
    sftpList: sshOk(),
    sftpStat: sshOk(),
    sftpMkdir: sshOk(),
    sftpRemove: sshOk(),
    sftpRename: sshOk(),
  }
  const events = new TestRemote(ctx, {
    settings: { describe, mutate },
    ssh,
  })
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
        'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      },
    } as never,
    () => null,
  )
  return { ctx, slots, locale, events, ssh, mutate }
}

afterEach(() => {
  document.head.querySelectorAll('style[data-ui-polish-ambient]').forEach((node) => { node.remove() })
  document.body.removeAttribute('data-ds-bg-image')
  document.body.removeAttribute('style')
})

describe('ui-polish apply', () => {
  it('declares the required services', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.ssh'])
  })

  it('registers the settings rows, dock entries, and view tabs, and unwinds on dispose', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries(GENERAL).map(e => e.options.id)).toEqual(['polish-background', 'polish-compaction', 'polish-pricing', 'polish-budget'])
    expect(b.slots.entries(DOCK).map(e => e.options.id)).toEqual(['polish-stats'])
    expect(b.slots.entries('conversation.view').map(e => e.options.id)).toEqual(['git', 'excalidraw', 'latex', 'ssh'])
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

  it('the budget row inject persists and syncs the dock store', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const row = b.slots.entries(GENERAL).find(e => e.component === BudgetRow)!
    const rowInstance = (row.store as ReturnType<typeof createBudgetRowStore>).create()
    const dock = b.slots.entries(DOCK).find(e => e.component === StatsFloat)!
    const dockInstance = (dock.store as ReturnType<typeof createBudgetRowStore>).create()
    // Both scopes receive the same writer; each mount syncs its own handle.
    const dockInject = dock.inject as unknown as (session: string, a: typeof dockInstance.actions) => unknown
    dockInject('session-1', dockInstance.actions)
    const face = (row.inject as unknown as (
      a: typeof rowInstance.actions,
    ) => { setBudget: (v: number | null) => void })(rowInstance.actions)
    face.setBudget(50)
    await vi.waitFor(() => { expect(rowInstance.getSnapshot().budget).toBe(50) })
    await vi.waitFor(() => { expect(dockInstance.getSnapshot().budget).toBe(50) })
    face.setBudget(null)
    await vi.waitFor(() => { expect(rowInstance.getSnapshot().budget).toBeNull() })
    await fiber.dispose()
  })

  it('makes every page surface transparent for the background image, except the canvas panel', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const ambient = document.head.querySelector('style[data-ui-polish-ambient]')!
    const sheet = ambient.textContent ?? ''
    // Page surfaces yield to the image (base + both raised layers + sidebar).
    for (const token of ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-specific-sidebar-fill']) {
      expect(sheet).toContain(`${token}: transparent;`)
    }
    // Overlays stay opaque so menus and dialogs keep reading against a photo.
    expect(sheet).not.toContain('--dsw-alias-bg-overlay: transparent;')
    // The canvas panel re-declares the raised surfaces from the overlay colour.
    const canvasRule = sheet.slice(sheet.indexOf('[data-ui-polish-excalidraw]'))
    expect(canvasRule).toContain('--dsw-alias-bg-base: var(--dsw-alias-bg-overlay);')
    expect(canvasRule).toContain('--dsw-alias-bg-layer-1: var(--dsw-alias-bg-overlay);')
    await fiber.dispose()
  })

  it('labels each view tab and registers the Excalidraw toolviews', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const t = b.locale.bind(NS)
    const views = b.slots.entries('conversation.view')
    const labelOf = (index: number): string | undefined => {
      const label = views[index]?.options.label
      return typeof label === 'function' ? label() : label
    }
    expect([0, 1, 2, 3].map(labelOf)).toEqual([
      t('git.tab'), t('excalidraw.title'), t('latex.tab'), t('ssh.title'),
    ])
    expect(b.slots.entries('tool.call.toolview').map(entry => entry.options.key)).toEqual([
      'excalidraw_draw', 'excalidraw_write', 'excalidraw_export',
    ])
    expect(b.slots.entries('tool.call.toolview').every(entry => entry.component === ExcalidrawToolView)).toBe(true)
    await fiber.dispose()
  })

  it('bridges the ssh panel to the remote namespace and its forwarded frames', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('conversation.view').find(candidate => candidate.component === SshPanel)!
    const face = (entry.inject as unknown as (sessionId: string) => SshPanelInjected)('session-1')

    await expect(face.rpc('ssh.list', {})).resolves.toEqual({ ok: true, value: { connections: [] } })
    for (const method of [
      'ssh.exec', 'ssh.pty.open', 'ssh.pty.attach', 'ssh.pty.resize', 'ssh.pty.close',
      'ssh.sftp.list', 'ssh.sftp.mkdir', 'ssh.sftp.remove', 'ssh.sftp.rename', 'ssh.sftp.stat',
    ]) {
      await expect(face.rpc(method, {})).resolves.toEqual({ ok: true, value: {} })
    }
    expect(b.ssh.exec).toHaveBeenCalledOnce()
    expect(b.ssh.ptyAttach).toHaveBeenCalledOnce()
    expect(b.ssh.sftpStat).toHaveBeenCalledOnce()
    // A denied host answer keeps its code and message for the panel.
    await expect(face.rpc('ssh.pty.write', {})).resolves.toEqual({
      ok: false, error: { message: 'E_DENIED: nope' },
    })
    await expect(face.rpc('ssh.unsupported', {})).rejects.toThrow(
      b.locale.bind(NS)('ssh.unsupportedMethod', { method: 'ssh.unsupported' }),
    )

    const onFrame = vi.fn()
    const onDrop = vi.fn()
    const off = face.subscribeHostFrames(onFrame, onDrop)
    b.events.emit('ssh/pty/output', [{ ptyId: 'p1', data: 'hi' }])
    expect(onFrame).toHaveBeenCalledWith({ type: 'ssh/pty/output', ptyId: 'p1', data: 'hi' })
    b.events.emit('ssh/pty/exit', [{ ptyId: 'p1' }])
    expect(onDrop).toHaveBeenCalledWith('p1')
    off()
    b.events.emit('ssh/pty/output', [{ ptyId: 'p2', data: 'again' }])
    expect(onFrame).toHaveBeenCalledOnce()
    await fiber.dispose()
  })

  it('the compaction row inject persists a ratio and syncs the store', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries(GENERAL).find(candidate => candidate.component === CompactionRow)!
    const instance = (entry.store as ReturnType<typeof createCompactionRowStore>).create()
    const face = (entry.inject as unknown as (
      actions: typeof instance.actions,
    ) => CompactionRowInjected)(instance.actions)

    await vi.waitFor(() => { expect(instance.getSnapshot().ratio).toBeNull() })
    face.setRatio(0.6)
    await vi.waitFor(() => { expect(instance.getSnapshot().ratio).toBe(0.6) })
    const lastWrite = b.mutate.mock.calls.at(-1)
    expect(lastWrite?.[0]).toBe(BACKGROUND_SETTINGS_NAMESPACE)
    expect(lastWrite?.[1]).toEqual([{ op: 'set', path: ['compactionThresholdRatio'], value: 0.6 }])
    face.setRatio(null)
    await vi.waitFor(() => { expect(instance.getSnapshot().ratio).toBeNull() })
    // A stale revision from an earlier mount is dropped instead of rolling back.
    instance.actions.sync(0.5, 0)
    expect(instance.getSnapshot().ratio).toBeNull()
    await fiber.dispose()
  })

  it('the pricing row inject saves and resets the user card', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries(GENERAL).find(candidate => candidate.component === PricingRow)!
    const instance = (entry.store as ReturnType<typeof createPricingRowStore>).create()
    const face = (entry.inject as unknown as (
      actions: typeof instance.actions,
    ) => PricingRowInjected)(instance.actions)

    await vi.waitFor(() => { expect(instance.getSnapshot().hasCustom).toBe(false) })
    expect(instance.getSnapshot().currentJson).toContain('"default"')
    const card = JSON.stringify({ default: { inputPerMillion: 2, outputPerMillion: 3 }, models: {} })
    face.save(card)
    await vi.waitFor(() => { expect(instance.getSnapshot().currentJson).toBe(card) })
    expect(instance.getSnapshot().hasCustom).toBe(true)
    face.reset()
    await vi.waitFor(() => { expect(instance.getSnapshot().hasCustom).toBe(false) })
    expect(instance.getSnapshot().currentJson).not.toBe(card)
    // A stale revision from an earlier mount is dropped instead of rolling back.
    instance.actions.sync(card, true, 0)
    expect(instance.getSnapshot().hasCustom).toBe(false)
    await fiber.dispose()
  })

  it('falls back to the seed card when the persisted card is corrupt', async () => {
    const b = await bench({ modelPricing: 'not json' })
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries(GENERAL).find(candidate => candidate.component === PricingRow)!
    const instance = (entry.store as ReturnType<typeof createPricingRowStore>).create()
    ;(entry.inject as unknown as (actions: typeof instance.actions) => PricingRowInjected)(instance.actions)

    // The row keeps showing the durable text so the user can repair it, while
    // the runtime prices with the built-in seed.
    await vi.waitFor(() => { expect(instance.getSnapshot().currentJson).toBe('not json') })
    expect(instance.getSnapshot().hasCustom).toBe(true)
    await fiber.dispose()
  })
})
