// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { apply, inject, NS } from '../src/client/index.ts'
import { McpSettingsTab } from '../src/client/McpSettingsTab.tsx'
import type { McpSettingsTabInjected } from '../src/client/McpSettingsTab.tsx'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const VIEW: McpManagedServerView = {
  name: 'docs', configured: true, oauth: true, status: { state: 'connected', toolCount: 3, connectedAt: 1 },
}

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  // One queue feeds the stream the plugin opens; a test pushes the next list.
  const queued: McpManagedServerView[][] = []
  let wake: (() => void) | undefined
  const push = (views: McpManagedServerView[]): void => { queued.push(views); wake?.(); wake = undefined }
  const watch = vi.fn((signal?: AbortSignal) => ({
    async *[Symbol.asyncIterator](): AsyncIterator<McpManagedServerView[]> {
      while (signal?.aborted !== true) {
        if (queued.length === 0) await new Promise<void>((resolve) => { wake = resolve })
        const next = queued.shift()
        if (next !== undefined) yield next
      }
    },
  }))
  const $stream = vi.fn((options: { open: (signal: AbortSignal) => AsyncIterable<McpManagedServerView[]> }) => {
    const controller = new AbortController()
    const source = options.open(controller.signal)
    return {
      async *[Symbol.asyncIterator]() {
        for await (const value of source) yield { value, generation: 1, accept: () => {} }
      },
      dispose: () => { controller.abort() },
    }
  })
  const authorize = vi.fn<() => Promise<RemoteResult<string | undefined>>>(async () => ({ ok: true, value: 'http://auth.example/authorize' }))
  const forgetAuthorization = vi.fn<() => Promise<RemoteResult<void>>>(async () => ({ ok: true, value: undefined }))
  const restart = vi.fn<() => Promise<RemoteResult<void>>>(async () => ({ ok: true, value: undefined }))
  class RemoteService extends Service {
    readonly $stream = $stream
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  ctx.provide('remote.mcpManager', { watch, authorize, forgetAuthorization, restart })
  return { ctx, locale, watch, $stream, authorize, forgetAuthorization, restart, push }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-mcp browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services the Settings tab uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.mcpManager'])
  })

  it('registers a localized tab and publishes the streamed list', async () => {
    const b = await bench()
    declare(b.ctx.get('slots') as SlotRegistry)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = (b.ctx.get('slots') as SlotRegistry).entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(McpSettingsTab)
    expect(entry.options).toMatchObject({ id: 'mcp', order: 20 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('MCP 服务器')
    expect(b.watch).toHaveBeenCalledOnce()

    const injected = (entry.inject as unknown as () => McpSettingsTabInjected)()
    expect(injected.snapshot()).toEqual({ servers: [] })
    const listener = vi.fn()
    const stop = injected.subscribe(listener)
    b.push([VIEW])
    await vi.waitFor(() => { expect(listener).toHaveBeenCalled() })
    expect(injected.snapshot()).toEqual({ servers: [VIEW] })
    stop()

    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('MCP servers')
  })

  it('opens the authorization URL and unwraps Host failures', async () => {
    const b = await bench()
    declare(b.ctx.get('slots') as SlotRegistry)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = ((b.ctx.get('slots') as SlotRegistry).entries('settings.plugins.tab')[0]!.inject as unknown as () => McpSettingsTabInjected)()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    onTestFinished(() => { open.mockRestore() })

    await injected.authorize('docs')
    expect(b.authorize).toHaveBeenCalledWith('docs')
    expect(open).toHaveBeenCalledWith('http://auth.example/authorize', '_blank', 'noopener,noreferrer')

    b.authorize.mockResolvedValueOnce({ ok: true, value: undefined })
    await injected.authorize('docs')
    expect(open).toHaveBeenCalledOnce()

    b.authorize.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'unavailable', {}) })
    await expect(injected.authorize('docs')).rejects.toThrow('gateway/internal: unavailable')

    await injected.forgetAuthorization('docs')
    expect(b.forgetAuthorization).toHaveBeenCalledWith('docs')
    await injected.restart('docs')
    expect(b.restart).toHaveBeenCalledWith('docs')

    b.restart.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'busy', {}) })
    await expect(injected.restart('docs')).rejects.toThrow('gateway/internal: busy')
  })

  it('reports an unavailable carrier in the snapshot', async () => {
    const b = await bench()
    const declared = declare(b.ctx.get('slots') as SlotRegistry)
    onTestFinished(declared)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = ((b.ctx.get('slots') as SlotRegistry).entries('settings.plugins.tab')[0]!.inject as unknown as () => McpSettingsTabInjected)()
    const options = b.$stream.mock.calls[0]![0] as unknown as { carrierFailed: () => void }
    options.carrierFailed()
    expect(injected.snapshot()).toMatchObject({ failure: 'unavailable' })
  })
})
