/** Commit-message bridge: route walking, delta forwarding, and terminal-failure handling. */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createCommitMessageBridge } from '../src/git-llm.ts'

/** Build a fake llm service over a fixed provider catalog and scripted streams. */
function fakeContext(
  catalog: Record<string, { id: string; name: string }[]>,
  streams: Record<string, () => AsyncIterable<unknown>>,
): Context {
  return {
    llm: {
      listProviders: () => Object.keys(catalog).map(id => ({ id })),
      listModels: async (provider: string) => catalog[provider] ?? [],
      stream: ({ provider }: { provider: string }) => {
        const open = streams[provider]
        if (open === undefined) throw new Error(`no stream scripted for ${provider}`)
        return open()
      },
    },
  } as unknown as Context
}

/** One scripted stream that emits the given chunks. */
function emit(chunks: readonly unknown[]): () => AsyncIterable<unknown> {
  return async function* () {
    for (const chunk of chunks) yield chunk
  }
}

/** A stream that fails before emitting anything. */
function fail(error: unknown): () => AsyncIterable<unknown> {
  return async function* () {
    throw error
  }
}

const TEXT = (text: string, index = 0) => ({ type: 'text-delta', index, text })
const FINISH = (kind = 'stop') => ({ type: 'finish', reason: { kind } })

const PARAMS = {
  system: 'sys',
  user: 'user',
  signal: new AbortController().signal,
  onText: () => {},
}

describe('createCommitMessageBridge', () => {
  it('streams the first route, forwards deltas, and trims the message', async () => {
    const ctx = fakeContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }] },
      { gateway: emit([TEXT(' feat: add '), TEXT('a file'), FINISH()]) },
    )
    const deltas: string[] = []
    const text = await createCommitMessageBridge(ctx).stream({ ...PARAMS, onText: delta => deltas.push(delta) })
    expect(text).toBe('feat: add a file')
    expect(deltas).toEqual([' feat: add ', 'a file'])
  })

  it('lists the flattened model catalog', async () => {
    const ctx = fakeContext({ gateway: [{ id: 'm1', name: 'Model 1' }], mirror: [{ id: 'm2', name: 'Model 2' }] }, {})
    expect(await createCommitMessageBridge(ctx).listModels()).toEqual([
      { provider: 'gateway', model: 'm1', name: 'Model 1' },
      { provider: 'mirror', model: 'm2', name: 'Model 2' },
    ])
  })

  it('falls through to the next route when one fails before emitting', async () => {
    const ctx = fakeContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }], mirror: [{ id: 'm2', name: 'Model 2' }] },
      { gateway: fail(new Error('no credentials')), mirror: emit([TEXT('feat: ok'), FINISH()]) },
    )
    await expect(createCommitMessageBridge(ctx).stream(PARAMS)).resolves.toBe('feat: ok')
  })

  it('does not fall through once a delta was emitted', async () => {
    const ctx = fakeContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }], mirror: [{ id: 'm2', name: 'Model 2' }] },
      {
        gateway: async function* () {
          yield TEXT('partial')
          throw new Error('stream dropped')
        },
        mirror: emit([TEXT('never'), FINISH()]),
      },
    )
    await expect(createCommitMessageBridge(ctx).stream(PARAMS)).rejects.toThrow('stream dropped')
  })

  it('does not fall through when the request was aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = fakeContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }], mirror: [{ id: 'm2', name: 'Model 2' }] },
      { gateway: fail(new Error('aborted')), mirror: emit([TEXT('never'), FINISH()]) },
    )
    await expect(createCommitMessageBridge(ctx).stream({ ...PARAMS, signal: controller.signal }))
      .rejects.toThrow('aborted')
  })

  it('aggregates every failure, including a non-Error rejection', async () => {
    const ctx = fakeContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }], mirror: [{ id: 'm2', name: 'Model 2' }] },
      { gateway: fail(new Error('down')), mirror: fail('offline') },
    )
    await expect(createCommitMessageBridge(ctx).stream(PARAMS))
      .rejects.toThrow('no model produced a message — gateway/m1: down; mirror/m2: offline')
  })

  it('rejects a stream that emits after its terminal finish', async () => {
    const ctx = fakeContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }] },
      { gateway: emit([TEXT('a'), FINISH(), TEXT('late')]) },
    )
    await expect(createCommitMessageBridge(ctx).stream(PARAMS)).rejects.toThrow(/after its terminal finish/)
  })

  it('rejects a generation that ends for a non-stop reason', async () => {
    const ctx = fakeContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }] },
      { gateway: emit([TEXT('a'), FINISH('length')]) },
    )
    await expect(createCommitMessageBridge(ctx).stream(PARAMS)).rejects.toThrow(/ended with length/)
  })

  it('rejects a stream that closes without a terminal finish', async () => {
    const ctx = fakeContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }] },
      { gateway: emit([TEXT('a')]) },
    )
    await expect(createCommitMessageBridge(ctx).stream(PARAMS)).rejects.toThrow(/no terminal finish/)
  })

  it('accepts a stream cut short by an abort without a finish', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = fakeContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }] },
      { gateway: emit([TEXT('partial')]) },
    )
    await expect(createCommitMessageBridge(ctx).stream({ ...PARAMS, signal: controller.signal }))
      .resolves.toBe('partial')
  })

  it('rejects an empty assembled message', async () => {
    const ctx = fakeContext(
      { gateway: [{ id: 'm1', name: 'Model 1' }] },
      { gateway: emit([TEXT('   '), FINISH()]) },
    )
    await expect(createCommitMessageBridge(ctx).stream(PARAMS)).rejects.toThrow(/empty message/)
  })

  it('forwards the model hint to the route walk', async () => {
    const stream = vi.fn(() => emit([TEXT('feat: x'), FINISH()])())
    const ctx = {
      llm: {
        listProviders: () => [{ id: 'gateway' }, { id: 'mirror' }],
        listModels: async () => [{ id: 'm1', name: 'Model 1' }, { id: 'm2', name: 'Model 2' }],
        stream,
      },
    } as unknown as Context
    await createCommitMessageBridge(ctx).stream({ ...PARAMS, model: 'mirror/m2' })
    expect(stream).toHaveBeenCalledOnce()
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mirror', model: 'm2', temperature: 0 }))
  })
})
