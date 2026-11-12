/** Real SDK negotiation, subscription, and cancellation through the connection supervisor. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { z } from 'zod'

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Client, InMemoryTransport, type JSONRPCMessage, type McpSubscription, type RequestOptions, type SubscriptionFilter, type Transport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'
import { McpStatusCell } from '../src/status.ts'
import { Config } from '../src/index.ts'

const { mockTransport } = vi.hoisted(() => ({ mockTransport: vi.fn<() => Transport>() }))
vi.mock('../src/transport.ts', () => ({ createTransport: mockTransport }))

function fixtureConfig(watch: { resourceWatchTimeoutMs?: number; maxResourceWatchTimeoutMs?: number } = {}): Config {
  return Config({
    transport: 'stdio', serverName: 'fixture', command: 'fixture', args: [], env: {}, cwd: '',
    toolCallTimeoutMs: 60_000, startupTimeoutMs: 30_000, failOnStartupError: true, ...watch,
  })
}

interface ConnectOptions {
  resources?: true
  /** Legacy-only server: connect directly instead of through `serveStdio`, which forces the modern era. */
  legacy?: boolean
  watch?: { resourceWatchTimeoutMs?: number; maxResourceWatchTimeoutMs?: number }
  /** Collect messages the client writes to the transport. */
  outbound?: JSONRPCMessage[]
}

async function connect(server: McpServer, options: ConnectOptions = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const serving = options.legacy === true ? undefined : serveStdio(() => server, { transport: serverTransport })
  if (serving === undefined) await server.connect(serverTransport)
  if (options.outbound !== undefined) {
    const outbound = options.outbound
    const send = clientTransport.send.bind(clientTransport)
    clientTransport.send = (message, sendOptions) => {
      outbound.push(message)
      return send(message, sendOptions)
    }
  }
  mockTransport.mockReturnValue(clientTransport)
  const connection = startConnection(ctx, fixtureConfig(options.watch), resolveReconnectPolicy({ enabled: false }, 'fixture'), new McpStatusCell(() => {}))
  onTestFinished(async () => {
    await connection.dispose()
    if (serving === undefined) await server.close()
    else await serving.close()
    await ctx.fiber.dispose()
  })
  expect(await connection.ready).toEqual({})
  if (options.resources === true) {
    await ctx.plugin(McpResources)
    ctx.mcpResources.register('fixture', connection.resources)
  }
  return ctx
}

/** Resource server with a change-notification handler shape both eras deliver. */
function resourceServer(options: {
  subscribe?: boolean
  legacy?: boolean
  onSubscribe?: () => void
  onUnsubscribe?: () => void
} = {}): McpServer {
  const server = new McpServer({ name: 'resources', version: '1' }, {
    capabilities: { resources: { subscribe: options.subscribe ?? true } },
    ...options.legacy === true ? { supportedProtocolVersions: ['2025-06-18'] } : {},
  })
  server.registerResource('memo', 'memo://readme', {}, async () => ({
    contents: [{ uri: 'memo://readme', text: 'memo' }],
  }))
  server.server.setRequestHandler('resources/subscribe', async () => {
    options.onSubscribe?.()
    return {}
  })
  server.server.setRequestHandler('resources/unsubscribe', async () => {
    options.onUnsubscribe?.()
    return {}
  })
  return server
}

function watchTool(ctx: Context, args: Record<string, unknown>, signal = new AbortController().signal) {
  return executeToolFixture(ctx, {
    name: 'watch_mcp_resource', arguments: { server: 'fixture', ...args },
    callId: ToolCallId('watch-resource'), signal,
  })
}

/** Let the acquire continuation register its waiter after the subscription ack. */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** Recorded modern listen handles, their call count, and the spy restore. */
type ListenRecorder = {
  readonly subscriptions: McpSubscription[]
  calls(): number
  restore(): void
}

/**
 * Record opened modern listen handles while leaving the SDK call in charge.
 * @returns opened subscriptions, the listen call count, and the spy restore.
 */
function recordListens(): ListenRecorder {
  // oxlint-disable-next-line typescript/unbound-method -- invoked below with the connected client as `this`
  const original = Client.prototype.listen
  const subscriptions: McpSubscription[] = []
  const spy = vi.spyOn(Client.prototype, 'listen').mockImplementation(function (
    this: Client,
    filter: SubscriptionFilter,
    options?: RequestOptions,
  ) {
    const opening = original.call(this, filter, options)
    void opening.then((subscription) => { subscriptions.push(subscription) }, () => undefined)
    return opening
  })
  return { subscriptions, calls: () => spy.mock.calls.length, restore: () => { spy.mockRestore() } }
}

describe('modern MCP connections', () => {
  it('keeps a resource-only server connected without requesting tools', async () => {
    const server = new McpServer({ name: 'resources', version: '1' })
    server.registerResource('memo', 'memo://readme', {}, async () => ({
      contents: [{ uri: 'memo://readme', text: 'memo' }],
    }))
    const ctx = await connect(server)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('keeps shared resource tools for a configured server without resource capability', async () => {
    const server = new McpServer({ name: 'tools-only', version: '1' })
    server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    const ctx = await connect(server, { resources: true })
    const names = ctx.tools.schemas().map(tool => tool.name)
    expect(names.toSorted()).toEqual([
      'list_mcp_resource_templates', 'list_mcp_resources', 'mcp__fixture__ping', 'read_mcp_resource',
      'watch_mcp_resource',
    ])
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    onTestFinished(() => { debug.mockRestore() })
    for (const [name, expected] of [
      ['list_mcp_resources', { resources: [] }],
      ['list_mcp_resource_templates', { resourceTemplates: [] }],
    ] as const) {
      const result = await executeToolFixture(ctx, {
        name, arguments: { server: 'fixture' },
        callId: ToolCallId(name), signal: new AbortController().signal,
      })
      expect(result).toMatchObject({ isError: false, value: expected })
    }
    // console.debug writes stdout, which the ACP profile reserves for JSON-RPC.
    expect(debug).not.toHaveBeenCalled()
    const read = await executeToolFixture(ctx, {
      name: 'read_mcp_resource', arguments: { server: 'fixture', uri: 'memo://readme' },
      callId: ToolCallId('unsupported-resource-read'), signal: new AbortController().signal,
    })
    expect(read.isError).toBe(true)
    if (read.isError) expect(read.error.message).toContain('Method not found')
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(names)
    const ping = await executeToolFixture(ctx, {
      name: 'mcp__fixture__ping', arguments: {},
      callId: ToolCallId('ping-after-resource-errors'), signal: new AbortController().signal,
    })
    expect(ping).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'pong' }] } })
  })

  it('reads resources and preserves explicit list and template cursors through the SDK', async () => {
    const server = new McpServer({ name: 'resources', version: '1' })
    server.registerResource('memo', 'memo://readme', {}, async () => ({
      contents: [{ uri: 'memo://readme', text: 'memo' }],
    }))
    const seen: (string | undefined)[] = []
    server.server.setRequestHandler('resources/list', async (request) => {
      const cursor = request.params?.cursor
      seen.push(cursor)
      return { resources: [{ name: 'memo', uri: 'memo://readme' }] }
    })
    server.server.setRequestHandler('resources/templates/list', async (request) => {
      seen.push(request.params?.cursor)
      return { resourceTemplates: [] }
    })
    const ctx = await connect(server, { resources: true })
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates']) {
      for (const cursor of [undefined, 'opaque-page']) {
        const result = await executeToolFixture(ctx, {
          name, arguments: { server: 'fixture', ...cursor === undefined ? {} : { cursor } },
          callId: ToolCallId(name), signal: new AbortController().signal,
        })
        expect(result.isError).toBe(false)
      }
    }
    expect(seen).toEqual([undefined, 'opaque-page', undefined, 'opaque-page'])
    const read = await executeToolFixture(ctx, {
      name: 'read_mcp_resource', arguments: { server: 'fixture', uri: 'memo://readme' },
      callId: ToolCallId('read-resource'), signal: new AbortController().signal,
    })
    expect(read).toMatchObject({ isError: false, value: { contents: [{ uri: 'memo://readme', text: 'memo' }] } })
  })

  it('updates tools through the SDK modern list-change subscription', async () => {
    const server = new McpServer({ name: 'tools', version: '1' })
    server.registerTool('first', { inputSchema: z.object({}) }, async () => ({ content: [] }))
    const ctx = await connect(server)
    expect(ctx.tools.get('mcp__fixture__first')).toBeDefined()
    server.registerTool('second', { inputSchema: z.object({}) }, async () => ({ content: [] }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__fixture__second')).toBeDefined() })
  })

  it('delivers caller cancellation to an executing modern tool', async () => {
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const cancelled: PromiseWithResolvers<void> = Promise.withResolvers()
    const server = new McpServer({ name: 'cancel', version: '1' })
    server.registerTool('wait', { inputSchema: z.object({}) }, async (_args, context) => {
      const signal = context.mcpReq.signal
      signal.addEventListener('abort', () => { cancelled.resolve() }, { once: true })
      entered.resolve()
      await cancelled.promise
      return { content: [] }
    })
    const ctx = await connect(server)
    const controller = new AbortController()
    const result = executeToolFixture(ctx, {
      callId: ToolCallId('cancel'), name: 'mcp__fixture__wait', arguments: {}, signal: controller.signal,
    })
    await entered.promise
    controller.abort(new Error('caller stopped'))
    expect((await result).isError).toBe(true)
    await cancelled.promise
  })

  it('returns the first resource update from a modern listen subscription', async () => {
    const listens = recordListens()
    onTestFinished(() => { listens.restore() })
    const server = resourceServer()
    const ctx = await connect(server, { resources: true })
    const result = watchTool(ctx, { uri: 'memo://readme', timeoutMs: 5_000 })
    await vi.waitFor(() => { expect(listens.subscriptions).toHaveLength(1) })
    // The subscription ack resolved; let the registry register its waiter.
    await flushMicrotasks()
    await server.server.sendResourceUpdated({ uri: 'memo://readme' })
    expect(await result).toMatchObject({ isError: false, value: { uri: 'memo://readme', updated: true } })
  })

  it('shares one modern subscription between concurrent watches of the same URI', async () => {
    const listens = recordListens()
    onTestFinished(() => { listens.restore() })
    const server = resourceServer()
    const ctx = await connect(server, { resources: true })
    const first = watchTool(ctx, { uri: 'memo://readme', timeoutMs: 5_000 })
    await vi.waitFor(() => { expect(listens.subscriptions).toHaveLength(1) })
    const [subscription] = listens.subscriptions
    if (subscription === undefined) throw new Error('the modern listen subscription was not recorded')
    const close = vi.spyOn(subscription, 'close')
    const second = watchTool(ctx, { uri: 'memo://readme', timeoutMs: 5_000 })
    // The second watch joins the existing subscription without another listen call.
    await flushMicrotasks()
    expect(listens.calls()).toBe(1)
    await server.server.sendResourceUpdated({ uri: 'memo://readme' })
    expect(await first).toMatchObject({ isError: false, value: { uri: 'memo://readme', updated: true } })
    expect(await second).toMatchObject({ isError: false, value: { uri: 'memo://readme', updated: true } })
    expect(close).toHaveBeenCalledOnce()
  })

  it('returns a timeout outcome and cancels the modern subscription', async () => {
    const outbound: JSONRPCMessage[] = []
    const server = resourceServer()
    const ctx = await connect(server, { resources: true, watch: { resourceWatchTimeoutMs: 30 }, outbound })
    expect(await watchTool(ctx, { uri: 'memo://readme' }))
      .toMatchObject({ isError: false, value: { uri: 'memo://readme', updated: false } })
    expect(outbound.some(message => 'method' in message && message.method === 'notifications/cancelled')).toBe(true)
  })

  it('releases the modern subscription when the tool call is cancelled', async () => {
    const outbound: JSONRPCMessage[] = []
    const listens = recordListens()
    onTestFinished(() => { listens.restore() })
    const server = resourceServer()
    const ctx = await connect(server, { resources: true, outbound })
    const controller = new AbortController()
    const result = watchTool(ctx, { uri: 'memo://readme', timeoutMs: 60_000 }, controller.signal)
    await vi.waitFor(() => { expect(listens.subscriptions).toHaveLength(1) })
    await flushMicrotasks()
    controller.abort(new Error('caller stopped'))
    expect((await result).isError).toBe(true)
    expect(outbound.some(message => 'method' in message && message.method === 'notifications/cancelled')).toBe(true)
  })

  it('fails clearly when the server does not advertise resource subscriptions', async () => {
    const ctx = await connect(resourceServer({ subscribe: false }), { resources: true })
    const result = await watchTool(ctx, { uri: 'memo://readme' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('does not advertise resource subscriptions')
  })

  it('subscribes and unsubscribes through the legacy resource methods', async () => {
    let subscribed = false
    let unsubscribed = false
    const server = resourceServer({
      legacy: true,
      onSubscribe: () => { subscribed = true },
      onUnsubscribe: () => { unsubscribed = true },
    })
    const ctx = await connect(server, { resources: true, legacy: true })
    const result = watchTool(ctx, { uri: 'memo://readme', timeoutMs: 5_000 })
    await vi.waitFor(() => { expect(subscribed).toBe(true) })
    await server.server.sendResourceUpdated({ uri: 'memo://readme' })
    expect(await result).toMatchObject({ isError: false, value: { uri: 'memo://readme', updated: true } })
    expect(unsubscribed).toBe(true)
  })

  it('rejects resource-watch limits where the default exceeds the maximum', () => {
    const ctx = new Context()
    const config = { ...fixtureConfig(), resourceWatchTimeoutMs: 20, maxResourceWatchTimeoutMs: 10 }
    expect(() => startConnection(ctx, config, resolveReconnectPolicy({ enabled: false }, 'fixture'), new McpStatusCell(() => {})))
      .toThrow('resourceWatchTimeoutMs must not exceed maxResourceWatchTimeoutMs')
  })

  it('rejects resource-watch limits that are not positive safe integers', () => {
    const ctx = new Context()
    for (const invalid of [0, 1.5]) {
      const config = { ...fixtureConfig(), resourceWatchTimeoutMs: invalid }
      expect(() => startConnection(ctx, config, resolveReconnectPolicy({ enabled: false }, 'fixture'), new McpStatusCell(() => {})))
        .toThrow('resourceWatchTimeoutMs must be a positive safe integer')
    }
  })
})
