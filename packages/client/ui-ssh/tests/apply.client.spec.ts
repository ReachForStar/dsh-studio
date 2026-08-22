// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { apply, NS } from '../src/client/index.ts'
import { en, type SshLocaleKey } from '../src/client/locales.ts'
import { SshSection } from '../src/client/SshSection.tsx'
import { SshConnectionsStore } from '../src/client/ssh-store.ts'

/**
 * The Settings registration wires this plugin's `apply(ctx)` into three
 * services: `ctx.effect` (register dictionaries), `ctx.slots.inject`
 * (contribute the ssh section), and the wrapped `ctx.remote.ssh` face. A
 * minimal in-memory ctx lets the contract run end to end without the cordis
 * runtime.
 */

/** Copy lookup standing in for the bound locale dictionary. */
const t = ((key: SshLocaleKey): string => en[key])

interface RegisteredSpec {
  name: string
  id: string
  order: number
  label: () => string
  inject: () => unknown
  locale: string
}

/** A wire call result: either a success value or a typed error payload. */
type WireResult =
  | { ok: true; value: object }
  | { ok: false; error: { code: string; message: string } }

type WireMethod = (...args: never[]) => Promise<WireResult>

const okList: WireMethod = vi.fn(async () => ({ ok: true as const, value: { connections: [] } }))
const okSave: WireMethod = vi.fn(async () => ({ ok: true as const, value: { id: 'saved' } }))
const okDelete: WireMethod = vi.fn(async () => ({ ok: true as const, value: { removed: true } }))
const okTest: WireMethod = vi.fn(async () => ({ ok: true as const, value: { ok: true, latencyMs: 2 } }))

function mockContext(overrides: Partial<Record<'list' | 'save' | 'delete' | 'test', WireMethod>> = {}) {
  const list: WireMethod = overrides.list ?? okList
  const save: WireMethod = overrides.save ?? okSave
  const del: WireMethod = overrides.delete ?? okDelete
  const test: WireMethod = overrides.test ?? okTest
  const effects: Array<() => void> = []
  let published: RegisteredSpec | undefined
  const ctx = {
    effect: vi.fn((callback: () => void): void => { effects.push(callback) }),
    locale: {
      register: vi.fn(),
      bind: vi.fn((_namespace: string) => t),
    },
    remote: {
      ssh: { list, save, delete: del, test },
    },
    slots: {
      inject: vi.fn((_name: string, setup: () => unknown): void => { setup() }),
      register: vi.fn((spec: RegisteredSpec, component: unknown) => {
        expect(component).toBe(SshSection)
        published = spec
        return () => {}
      }),
    },
  }
  return {
    ctx,
    remoteCalls: { list, save, delete: del, test },
    effects,
    published: () => published,
  }
}

describe('ui-ssh browser apply', () => {
  it('registers dictionaries, serves connections, and publishes the section', async () => {
    const { ctx, effects, published } = mockContext()
    apply(ctx as never)

    // Dictionary registration runs through the registered effect; run the
    // effects that apply() queued so the registration is observed on injection.
    for (const effect of effects) effect()
    expect(ctx.locale.register).toHaveBeenCalledWith(NS, expect.anything())

    // The section is published with a label and the injected controller.
    expect(ctx.slots.inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    const spec = published()
    expect(spec).toBeDefined()
    expect(spec!.id).toBe('ssh')
    expect(spec!.name).toBe('settings.section')
    expect(spec!.order).toBe(30)
    expect(spec!.label()).toBe(en.nav)
    const injected = spec!.inject() as { controller: SshConnectionsStore; hooks: { snapshot: unknown } }
    expect(injected.controller).toBeInstanceOf(SshConnectionsStore)
    expect(injected.hooks.snapshot).toBeDefined()

    // A load through the section's controller reaches the wrapped remote.
    await injected.controller.load()
    expect(injected.controller.store.getSnapshot().status).toBe('ready')

    // Successful save/remove/test round-trips exercise the ok:true returns of
    // every wrapped wire face.
    const saved = await injected.controller.save({ name: 'n', host: 'h', username: 'u', authKind: 'password' })
    expect(saved.id).toBe('saved')
    await injected.controller.remove('saved')
    const outcome = await injected.controller.test('saved')
    expect(outcome.ok).toBe(true)
  })

  it('propagates list errors from the wire as thrown messages', async () => {
    const { ctx, published } = mockContext({
      list: vi.fn(async () => ({ ok: false as const, error: { code: 'E', message: 'broken' } })),
    })
    apply(ctx as never)
    const spec = published()!
    const injected = spec.inject() as { controller: SshConnectionsStore }
    await injected.controller.load()
    expect(injected.controller.store.getSnapshot().status).toBe('error')
    expect(injected.controller.store.getSnapshot().error).toBe('ssh.list failed: E: broken')
  })

  it('propagates save, remove, and test errors from the wire as thrown messages', async () => {
    const { ctx, published } = mockContext({
      save: vi.fn(async () => ({ ok: false as const, error: { code: 'E', message: 'save down' } })),
      delete: vi.fn(async () => ({ ok: false as const, error: { code: 'E', message: 'delete down' } })),
      test: vi.fn(async () => ({ ok: false as const, error: { code: 'E', message: 'test down' } })),
    })
    apply(ctx as never)
    const spec = published()!
    const injected = spec.inject() as { controller: SshConnectionsStore }

    await expect(injected.controller.save({ name: 'n', host: 'h', username: 'u', authKind: 'password' }))
      .rejects.toThrow('ssh.save failed: E: save down')
    await expect(injected.controller.remove('id-1')).rejects.toThrow('ssh.delete failed: E: delete down')
    await expect(injected.controller.test('id-1')).rejects.toThrow('ssh.test failed: E: test down')
  })
})
