/** Shared MCP connections: key identity, holder lifetime, and private fallback. */

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createMcpClient } from '../src/client.ts'
import { resolveReconnectPolicy, startConnection } from '../src/connection.ts'
import type { Config, StdioConfig } from '../src/index.ts'
import McpPool from '../src/pool.ts'
import { poolKey } from '../src/pool-key.ts'
import { ResourceWatchRegistry } from '../src/resource-watch.ts'
import { McpStatusCell } from '../src/status.ts'

const { mockTransport } = vi.hoisted(() => ({ mockTransport: vi.fn<() => Transport>() }))
vi.mock('../src/transport.ts', () => ({ createTransport: mockTransport }))

const baseConfig: StdioConfig = {
  transport: 'stdio', serverName: 'shared', command: 'fixture', args: [], env: {}, cwd: '',
  toolCallTimeoutMs: 60_000, resourceWatchTimeoutMs: 30_000, maxResourceWatchTimeoutMs: 300_000,
  startupTimeoutMs: 30_000, closeTimeoutMs: 5_000,
  expandTemplates: false, failOnStartupError: false,
}

beforeEach(() => { mockTransport.mockReset() })

const policy = resolveReconnectPolicy({ enabled: false }, 'fixture')

/** Start one supervised instance against the mocked transport. */
function start(ctx: Context, overrides: Partial<StdioConfig> = {}) {
  const status = new McpStatusCell(() => {})
  const connection = startConnection(ctx, { ...baseConfig, ...overrides }, policy, status)
  return { connection, status }
}

/** Mount the tool registry and the pool on a fresh context. */
async function mountPool(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpPool)
  return ctx
}

/** A server with one tool and one subscribable resource, plus its linked transport pair. */
async function serveFixture() {
  const server = new McpServer(
    { name: 'fixture', version: '1' },
    { capabilities: { tools: {}, resources: { subscribe: true } } },
  )
  server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
  server.registerResource('readme', 'memo://readme', { title: 'Readme', mimeType: 'text/plain' },
    async uri => ({ contents: [{ uri: uri.href, text: 'hello' }] }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const serving = serveStdio(() => server, { transport: serverTransport })
  return { server, clientTransport, closeServer: () => serving.close() }
}

/** A transport that refuses the handshake. */
function refusingTransport(): Transport {
  return {
    start: () => Promise.reject(new Error('shared handshake refused')),
    send: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }
}

/** A transport whose handshake never settles. */
function hangingTransport(): Transport {
  return {
    start: () => Promise.resolve(),
    send: () => new Promise(() => {}),
    close: () => Promise.resolve(),
  }
}

describe('poolKey', () => {
  it('ignores the server name and the order of environment entries', () => {
    const left = poolKey({ ...baseConfig, env: { A: '1', B: '2' } })
    const right = poolKey({ ...baseConfig, serverName: 'other', env: { B: '2', A: '1' } })
    expect(left).toBe(right)
  })

  it.each([
    ['command', { command: 'other' }],
    ['argument', { args: ['--flag'] }],
    ['working directory', { cwd: '/workspace' }],
    ['environment value', { env: { A: '1' } }],
    ['startup budget', { startupTimeoutMs: 1_000 }],
    ['close budget', { closeTimeoutMs: 1_000 }],
  ])('separates connections that differ by %s', (_label, change) => {
    expect(poolKey({ ...baseConfig, ...change })).not.toBe(poolKey(baseConfig))
  })

  it('treats an absent startup budget as its own key', () => {
    const { startupTimeoutMs: _budget, ...withoutBudget } = baseConfig
    expect(poolKey(withoutBudget)).not.toBe(poolKey(baseConfig))
  })

  it('separates transports and remote endpoints', () => {
    const remote = { ...baseConfig, transport: 'streamable-http', url: 'http://127.0.0.1/mcp', headers: {} } as Config
    expect(poolKey(remote)).not.toBe(poolKey(baseConfig))
    expect(poolKey({ ...remote, url: 'http://127.0.0.1/other' } as Config)).not.toBe(poolKey(remote))
    expect(poolKey({ ...remote, headers: { authorization: 'Bearer a' } } as Config)).not.toBe(poolKey(remote))
  })
})

describe('shared connections', () => {
  it('opens one transport for two instances and keeps it open until the last releases', async () => {
    const ctx = await mountPool()
    const { clientTransport, closeServer } = await serveFixture()
    onTestFinished(closeServer)
    const closed = vi.spyOn(clientTransport, 'close')
    mockTransport.mockReturnValue(clientTransport)

    const alpha = start(ctx, { serverName: 'alpha' })
    const beta = start(ctx, { serverName: 'beta' })
    onTestFinished(async () => { await alpha.connection.dispose(); await beta.connection.dispose() })
    await alpha.connection.ready
    await beta.connection.ready

    expect(mockTransport).toHaveBeenCalledTimes(1)
    expect(ctx.tools.get('mcp__alpha__ping')).toBeDefined()
    expect(ctx.tools.get('mcp__beta__ping')).toBeDefined()

    await alpha.connection.dispose()
    expect(closed).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__beta__ping')).toBeDefined()

    await beta.connection.dispose()
    expect(closed).toHaveBeenCalled()
    expect(alpha.status.closure()).toEqual({ closeConfirmed: true })
    expect(beta.status.closure()).toEqual({ closeConfirmed: true })
  })

  it('forwards tool-list and resource updates to every holder', async () => {
    const ctx = await mountPool()
    const { clientTransport, closeServer, server } = await serveFixture()
    onTestFinished(closeServer)
    mockTransport.mockReturnValue(clientTransport)
    const pool = ctx.mcpPool
    const signal = new AbortController().signal
    const alpha = await pool.acquire(baseConfig, { signal })
    const beta = await pool.acquire({ ...baseConfig, serverName: 'beta' }, { signal })
    onTestFinished(async () => { await alpha?.release(); await beta?.release() })
    const tools = { alpha: 0, beta: 0 }
    const updates = { alpha: [] as string[], beta: [] as string[] }
    alpha?.onToolsChanged(() => { tools.alpha++ })
    beta?.onToolsChanged(() => { tools.beta++ })
    alpha?.onResourceUpdated(uri => updates.alpha.push(uri))
    beta?.onResourceUpdated(uri => updates.beta.push(uri))

    await alpha?.client.listen({ resourceSubscriptions: ['memo://readme'] })
    await server.server.sendToolListChanged()
    await server.server.sendResourceUpdated({ uri: 'memo://readme' })
    await vi.waitFor(() => {
      expect(tools).toEqual({ alpha: 1, beta: 1 })
      expect(updates).toEqual({ alpha: ['memo://readme'], beta: ['memo://readme'] })
    })
  })

  it('reports a lost shared connection to every instance', async () => {
    const ctx = await mountPool()
    const { clientTransport, closeServer } = await serveFixture()
    onTestFinished(closeServer)
    mockTransport.mockReturnValue(clientTransport)
    const alpha = start(ctx, { serverName: 'alpha' })
    const beta = start(ctx, { serverName: 'beta' })
    onTestFinished(async () => { await alpha.connection.dispose(); await beta.connection.dispose() })
    await alpha.connection.ready
    await beta.connection.ready

    await clientTransport.close()
    await vi.waitFor(() => {
      expect(alpha.status.current()).toMatchObject({ state: 'failed', reason: 'reconnect-disabled' })
      expect(beta.status.current()).toMatchObject({ state: 'failed', reason: 'reconnect-disabled' })
    })
  })

  it('connects privately after a refused shared handshake and stops sharing that key', async () => {
    const ctx = await mountPool()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const first = await serveFixture()
    const second = await serveFixture()
    onTestFinished(first.closeServer)
    onTestFinished(second.closeServer)
    mockTransport.mockReturnValueOnce(refusingTransport()).mockReturnValue(first.clientTransport)

    const alpha = start(ctx, { serverName: 'alpha' })
    onTestFinished(() => alpha.connection.dispose())
    await alpha.connection.ready
    expect(ctx.tools.get('mcp__alpha__ping')).toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shared connection failed'))

    mockTransport.mockReturnValue(second.clientTransport)
    const beta = start(ctx, { serverName: 'beta' })
    onTestFinished(() => beta.connection.dispose())
    await beta.connection.ready
    expect(ctx.tools.get('mcp__beta__ping')).toBeDefined()
    // The refused shared attempt, then one private connection per instance.
    expect(mockTransport).toHaveBeenCalledTimes(3)
  })

  it('marks a configuration unshareable when its transport cannot be created', async () => {
    const ctx = await mountPool()
    const warn = vi.spyOn(ctx.logger, 'warn')
    mockTransport.mockImplementation(() => { throw new TypeError('secret-token refused') })
    const redact = (text: string): string => text.replaceAll('secret-token', '[redacted]')
    const signal = new AbortController().signal
    await expect(ctx.mcpPool.acquire(baseConfig, { signal, redact })).rejects.toThrow('secret-token refused')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[redacted]'))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('secret-token'))
    await expect(ctx.mcpPool.acquire(baseConfig, { signal })).resolves.toBeUndefined()
  })

  it('does not share different keys', async () => {
    const ctx = await mountPool()
    const first = await serveFixture()
    const second = await serveFixture()
    onTestFinished(first.closeServer)
    onTestFinished(second.closeServer)
    mockTransport.mockReturnValueOnce(first.clientTransport).mockReturnValue(second.clientTransport)

    const alpha = start(ctx, { serverName: 'alpha' })
    const beta = start(ctx, { serverName: 'beta', command: 'other' })
    onTestFinished(async () => { await alpha.connection.dispose(); await beta.connection.dispose() })
    await alpha.connection.ready
    await beta.connection.ready
    expect(mockTransport).toHaveBeenCalledTimes(2)
  })

  it('drops a holder whose wait was cancelled without closing the shared transport', async () => {
    const ctx = await mountPool()
    const pool = ctx.mcpPool
    const cancelled = new AbortController()
    cancelled.abort(new Error('caller left'))
    await expect(pool.acquire(baseConfig, { signal: cancelled.signal })).rejects.toThrow('caller left')

    const { clientTransport, closeServer } = await serveFixture()
    onTestFinished(closeServer)
    mockTransport.mockReturnValue(clientTransport)
    const lease = await pool.acquire(baseConfig, { signal: new AbortController().signal })
    expect(lease).toBeDefined()
    await lease?.release()
  })

  it('cancels one holder while the shared handshake continues for another', async () => {
    const ctx = await mountPool()
    mockTransport.mockReturnValue(hangingTransport())
    const pool = ctx.mcpPool
    const leaving = new AbortController()
    const stopped = new AbortController()
    const first = pool.acquire(baseConfig, { signal: leaving.signal })
    const second = pool.acquire({ ...baseConfig, serverName: 'beta' }, { signal: stopped.signal })

    leaving.abort(new Error('caller left'))
    await expect(first).rejects.toThrow('caller left')
    stopped.abort('stop')
    await expect(second).rejects.toThrow('MCP pool wait aborted')
  })

  it('forgets a closed connection without disturbing its replacement', async () => {
    const ctx = await mountPool()
    const first = await serveFixture()
    const second = await serveFixture()
    onTestFinished(first.closeServer)
    onTestFinished(second.closeServer)
    mockTransport.mockReturnValueOnce(first.clientTransport).mockReturnValue(second.clientTransport)
    const pool = ctx.mcpPool
    const signal = new AbortController().signal
    const lease = await pool.acquire(baseConfig, { signal })
    await first.clientTransport.close()
    const replacement = await pool.acquire(baseConfig, { signal })
    onTestFinished(async () => { await lease?.release(); await replacement?.release() })
    expect(replacement?.client).not.toBe(lease?.client)
    await lease?.release()
    expect(await pool.acquire(baseConfig, { signal })).toBeDefined()
  })

  it('closes every shared connection when the service is disposed', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    const toolRuntime = await ctx.plugin(ToolRuntime)
    const pool = await ctx.plugin(McpPool)
    const { clientTransport, closeServer } = await serveFixture()
    onTestFinished(closeServer)
    const closed = vi.spyOn(clientTransport, 'close')
    mockTransport.mockReturnValue(clientTransport)

    const lease = await ctx.mcpPool.acquire(baseConfig, { signal: new AbortController().signal })
    expect(lease).toBeDefined()
    await pool.dispose()
    expect(closed).toHaveBeenCalled()
    await toolRuntime.dispose()
  })

  it('replays a close to a lease that registers after it', async () => {
    const ctx = await mountPool()
    const { clientTransport, closeServer } = await serveFixture()
    onTestFinished(closeServer)
    mockTransport.mockReturnValue(clientTransport)
    const lease = await ctx.mcpPool.acquire(baseConfig, { signal: new AbortController().signal })
    await clientTransport.close()
    let closed = 0
    const unobserve = lease?.onClose(() => { closed++ })
    expect(closed).toBe(1)
    unobserve?.()
  })

  it('ignores a repeated close notification', async () => {
    const ctx = await mountPool()
    const { clientTransport, closeServer } = await serveFixture()
    onTestFinished(closeServer)
    mockTransport.mockReturnValue(clientTransport)
    const lease = await ctx.mcpPool.acquire(baseConfig, { signal: new AbortController().signal })
    onTestFinished(async () => { await lease?.release() })
    let closed = 0
    lease?.onClose(() => { closed++ })
    lease?.client.onclose?.()
    lease?.client.onclose?.()
    expect(closed).toBe(1)
  })

  it('reports a shared cleanup failure through the diagnostic filter', async () => {
    const ctx = await mountPool()
    const { clientTransport, closeServer } = await serveFixture()
    onTestFinished(closeServer)
    clientTransport.close = () => Promise.reject(new Error('close failed'))
    mockTransport.mockReturnValue(clientTransport)
    const lease = await ctx.mcpPool.acquire({ ...baseConfig, closeTimeoutMs: 50 },
      { signal: new AbortController().signal })
    expect(lease).toBeDefined()
    const closed = await lease?.release()
    expect(closed?.cleanupError).toContain('close failed')
  })

  it('leaves the client notification handler to the shared connection', async () => {
    const { clientTransport, closeServer } = await serveFixture()
    onTestFinished(closeServer)
    const client = createMcpClient(() => {})
    await client.connect(clientTransport)
    onTestFinished(() => client.close())
    const handler = vi.spyOn(client, 'setNotificationHandler')
    const registry = new ResourceWatchRegistry({
      client, label: 'pooled', requestTimeoutMs: 1_000, defaultWaitMs: 1_000, maxWaitMs: 1_000,
      installHandler: false,
    })
    const lifetime = new AbortController()
    const watching = registry.watch('memo://readme', undefined, lifetime.signal, lifetime.signal)
    const notify = setInterval(() => { registry.notify('memo://readme') }, 5)
    onTestFinished(() => { clearInterval(notify); lifetime.abort() })
    await expect(watching).resolves.toMatchObject({ uri: 'memo://readme', updated: true })
    expect(handler).not.toHaveBeenCalled()
  })
})
