// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { SshConnectionsStore, type SshRemoteFace } from '../src/client/ssh-store.ts'
import type { SshRemoteDefinition, SshRemoteSaveRequest, SshRemoteTestResult } from '@deepseek-ai/dsh-api-remotes/client'

function definition(overrides: Partial<SshRemoteDefinition> = {}): SshRemoteDefinition {
  return {
    id: 'id-1',
    name: 'box',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authKind: 'password',
    passwordSet: true,
    privateKeyPath: null,
    passphraseSet: false,
    connectTimeoutMs: 10_000,
    ...overrides,
  }
}

function remote(overrides: Partial<SshRemoteFace> = {}) {
  return {
    list: vi.fn(async () => ({ connections: [definition()] })),
    save: vi.fn(async (request: SshRemoteSaveRequest) => definition({ name: request.name })),
    remove: vi.fn(async () => ({ removed: true })),
    test: vi.fn(async (): Promise<SshRemoteTestResult> => ({ ok: true, latencyMs: 3 })),
    ...overrides,
  }
}

describe('SshConnectionsStore', () => {
  it('loads the connection list into the snapshot', async () => {
    const store = new SshConnectionsStore(remote())
    expect(store.store.getSnapshot().status).toBe('idle')
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.connections).toHaveLength(1)
    expect(state.connections[0]!.name).toBe('box')
  })

  it('surfaces load failures without losing the loading state', async () => {
    const store = new SshConnectionsStore(remote({ list: vi.fn(async () => { throw new Error('wire down') }) }))
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('wire down')
  })

  it('saves and removes through the wire, then refreshes the list', async () => {
    const api = remote({
      list: vi.fn(async () => ({ connections: [] })),
      save: vi.fn(async (request: SshRemoteSaveRequest) => definition({ id: 'new-id', name: request.name })),
    })
    const store = new SshConnectionsStore(api)
    const saved = await store.save({ name: 'fresh', host: 'h', username: 'u', authKind: 'password' })
    expect(saved.id).toBe('new-id')
    expect(api.list).toHaveBeenCalledTimes(1) // the post-save refresh

    await store.remove('new-id')
    expect(api.remove).toHaveBeenCalledWith('new-id')
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('probes a connection and never throws for a failed probe', async () => {
    const api = remote({ test: vi.fn(async (): Promise<SshRemoteTestResult> => ({ ok: false, error: 'nope' })) })
    const store = new SshConnectionsStore(api)
    const outcome = await store.test('id-1')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('nope')
  })

  it('ignores a stale load that settles after a newer one (generation guard)', async () => {
    const deferred = Promise.withResolvers<{ connections: SshRemoteDefinition[] }>()
    const api = remote({ list: vi.fn().mockReturnValueOnce(deferred.promise).mockResolvedValueOnce({ connections: [] }) })
    const store = new SshConnectionsStore(api)
    const first = store.load()
    await store.load()
    deferred.resolve({ connections: [definition({ name: 'stale' })] })
    await first
    expect(store.store.getSnapshot().connections).toEqual([])
  })

  it('dispose stops further loads from committing', async () => {
    const store = new SshConnectionsStore(remote())
    store.dispose()
    await store.load()
    expect(store.store.getSnapshot().status).toBe('idle')
  })
})
