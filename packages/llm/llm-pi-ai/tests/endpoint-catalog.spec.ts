/**
 * Runtime endpoint catalogs: a route whose models neither the configuration nor
 * the installed catalog supplies reads them from its own endpoint, once per
 * configuration, which is what makes a gateway with no shipped catalog routable
 * without listing its models by hand.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { AMAX_API_KEY_ENV } from '../src/catalog.ts'
import type { RouteCatalogRequest } from '../src/catalog.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, resolveProfiles } from '../src/config.ts'
import { routeEndpointCatalog } from '../src/discovery.ts'
import type { EndpointCatalogSource } from '../src/discovery.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
  // A held-open listing keeps its socket; closing the server alone would wait
  // for the request this test deliberately left unanswered.
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
})

/** A listing endpoint that accepts the request and never answers it. */
async function silentListingServer(): Promise<string> {
  const server = createServer(() => {
    // Answered by nothing: only the route's own bound can end this wait.
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

/** The route facts one hand-declared gateway resolves from, with the caller's fields layered on. */
function routeFacts(overrides: Partial<RouteCatalogRequest> = {}): RouteCatalogRequest {
  return {
    provider: 'acme-gateway',
    baseURL: 'https://acme.test/v1',
    defaultInput: ['text'],
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    ...overrides,
  }
}

/** One endpoint-served route, with the reading the caller scripts for it. */
function adapterOf(
  discoverEndpointCatalog?: (source: EndpointCatalogSource) => Promise<readonly LlmDiscoveredModel[]>,
  providers: Record<string, LlmPiAi.PiAiProviderProfile> = {
    'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test/v1', apiKeyEnv: 'PI_TEST_KEY' },
  },
): PiAiAdapter {
  // Resolved once, because the adapter recognizes an unchanged configuration by
  // the profile map's identity — what the plugin's memoized getter hands it.
  const profiles = resolveProfiles(providers)
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
    ...discoverEndpointCatalog === undefined ? {} : { discoverEndpointCatalog },
  })
}

/** The listing every adapter case below serves, with capacities the endpoint disclosed. */
const GATEWAY_LISTING: readonly LlmDiscoveredModel[] = [
  { id: 'gateway-large', name: 'Gateway Large', contextWindow: 65536, maxTokens: 4096 },
]

describe('endpoint catalog eligibility', () => {
  it('reads a route whose models the installed catalog does not describe', () => {
    const source = routeEndpointCatalog(routeFacts())

    expect(source?.baseURL).toBe('https://acme.test/v1')
    expect(source?.api).toBe('openai-completions')
    // The reading reuses the route's own facts, so a model it materializes has
    // the capacities and protocol a configured one would.
    expect(source?.request.defaultContextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('answers for the catalog card endpoint when the configuration names none', () => {
    const profiles = resolveProfiles({ amax: { apiKeyEnv: 'AMAX_API_KEY' } })

    expect(profiles.get('amax')?.endpointCatalog)
      .toMatchObject({ baseURL: 'https://ai.amaxsmp.com/v1', api: 'openai-completions' })
  })

  it('leaves a route that listed its own models, and a catalog route, unread', () => {
    expect(resolveProfiles({ amax: { models: [{ id: 'deepseek-v4-flash' }] } }).get('amax')?.endpointCatalog)
      .toBeUndefined()
    expect(resolveProfiles({ deepseek: {} }).get('deepseek')?.endpointCatalog).toBeUndefined()
  })

  it('needs an endpoint whose protocol has a listing this build can read', () => {
    expect(routeEndpointCatalog(routeFacts({ baseURL: '' }))).toBeUndefined()
    expect(routeEndpointCatalog(routeFacts({ api: 'bedrock-converse-stream' }))).toBeUndefined()
    expect(routeEndpointCatalog(routeFacts({ models: [{ id: 'gateway-large' }] }))).toBeUndefined()
    // A route that names no protocol is read as OpenAI Chat Completions, the
    // same assumption the configuration surface's fetch action makes.
    expect(routeEndpointCatalog(routeFacts())?.api).toBe('openai-completions')
  })

  it('accepts the route at a settings write, and still refuses one nothing can read', () => {
    expect(() => {
      resolveProfiles({ 'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test/v1' } })
    }).not.toThrow()
    // No endpoint to read and no models to serve: the configuration error the
    // route always was.
    expect(() => {
      resolveProfiles({ 'acme-gateway': { api: 'openai-completions' } })
    }).toThrow(/resolves no models/)
  })
})

describe('reading a route from its own endpoint', () => {
  it('resolves and lists the models the endpoint named', async () => {
    const read = vi.fn((_request: unknown) => Promise.resolve(GATEWAY_LISTING))
    const adapter = adapterOf(read)

    await expect(adapter.resolveModel('acme-gateway', 'gateway-large')).resolves.toMatchObject({
      id: 'gateway-large',
      name: 'Gateway Large',
      context: { contextWindow: 65536 },
      defaultMaxTokens: 4096,
    })
    await expect(adapter.listModels('acme-gateway')).resolves.toEqual([
      { provider: 'acme-gateway', id: 'gateway-large', name: 'Gateway Large', inputModalities: ['text'] },
    ])
    // One reading serves every operation the configuration lasts for.
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('materializes a listing that discloses nothing but ids', async () => {
    const adapter = adapterOf(() => Promise.resolve([{ id: 'gateway-small' }, { id: 'gateway-large', name: 'Large' }]))

    await expect(adapter.listModels('acme-gateway')).resolves.toEqual([
      { provider: 'acme-gateway', id: 'gateway-small', name: 'gateway-small', inputModalities: ['text'] },
      { provider: 'acme-gateway', id: 'gateway-large', name: 'Large', inputModalities: ['text'] },
    ])
  })

  it('shares one reading between operations that ask at the same time', async () => {
    const answer = Promise.withResolvers<readonly LlmDiscoveredModel[]>()
    const read = vi.fn(() => answer.promise)
    const adapter = adapterOf(read)

    const both = Promise.all([
      adapter.listModels('acme-gateway'),
      adapter.resolveModel('acme-gateway', 'gateway-large'),
    ])
    await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
    answer.resolve(GATEWAY_LISTING)

    await expect(both).resolves.toHaveLength(2)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reads again after the configuration changes', async () => {
    const read = vi.fn((_request: unknown) => Promise.resolve(GATEWAY_LISTING))
    // Memoized the way the plugin's own getter is: an unchanged configuration
    // keeps its map, a changed one arrives as a new map.
    let providers: Record<string, LlmPiAi.PiAiProviderProfile> = {
      'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test/v1' },
    }
    let profiles = resolveProfiles(providers)
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
      discoverEndpointCatalog: read,
    })

    await adapter.listModels('acme-gateway')
    await adapter.listModels('acme-gateway')
    expect(read).toHaveBeenCalledTimes(1)

    providers = { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test/v2' } }
    profiles = resolveProfiles(providers)
    await adapter.listModels('acme-gateway')

    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]?.[0]).toMatchObject({ baseURL: 'https://acme.test/v2' })
  })

  it('reports the endpoint fault a request on that route hits', async () => {
    const refused = new LlmError('acme.test answered 401; check the API key', 'DISCOVERY_FAILED')
    const adapter = adapterOf(() => Promise.reject(refused))

    await expect(adapter.resolveModel('acme-gateway', 'gateway-large')).rejects.toBe(refused)
    // Listing answers what the route serves, which is nothing while its catalog
    // cannot be read; the fault is reported where a request would hit it.
    await expect(adapter.listModels('acme-gateway')).resolves.toEqual([])
  })

  it('names the route and reason when the reading failed for another reason', async () => {
    const adapter = adapterOf(() => Promise.reject(new TypeError('not a listing')))

    await expect(adapter.resolveModel('acme-gateway', 'gateway-large')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('provider "acme-gateway" endpoint catalog could not be read: not a listing') as string,
    })
  })

  it('reports a reading that failed without an error at all', async () => {
    // A reader that throws a value which is no Error is exactly what this case reports.
    const adapter = adapterOf(() => { throw 'gateway offline' })

    await expect(adapter.resolveModel('acme-gateway', 'gateway-large')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('could not be read: gateway offline') as string,
    })
  })

  it('reads the catalog card endpoint when the route configures none of its own', async () => {
    const read = vi.fn((_request: unknown) => Promise.resolve(GATEWAY_LISTING))
    const adapter = adapterOf(read, { amax: { apiKeyEnv: 'AMAX_API_KEY' } })

    await expect(adapter.resolveModel('amax', 'gateway-large')).resolves.toMatchObject({ id: 'gateway-large' })
    expect(read.mock.calls[0]?.[0]).toMatchObject({ baseURL: 'https://ai.amaxsmp.com/v1', api: 'openai-completions' })
  })

  it('keeps the routes the configuration materialized alongside the one it read', async () => {
    const adapter = adapterOf(() => Promise.resolve(GATEWAY_LISTING), {
      deepseek: {},
      'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test/v1' },
    })

    await expect(adapter.listModels('acme-gateway')).resolves.toHaveLength(1)
    // The merged collection still serves the route the configuration alone
    // materialized; a snapshot that dropped it would break every other route.
    await expect(adapter.resolveModel('deepseek', 'deepseek-v4-flash')).resolves.toMatchObject({ id: 'deepseek-v4-flash' })
  })

  it('refuses a listing that names no model to serve', async () => {
    const adapter = adapterOf(() => Promise.resolve([{ id: '' }]))

    await expect(adapter.resolveModel('acme-gateway', 'gateway-large')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('named no models to serve') as string,
    })
  })

  it('reports a route this build was given no way to read', async () => {
    const adapter = adapterOf()

    await expect(adapter.resolveModel('acme-gateway', 'gateway-large')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('no way to read') as string,
    })
  })
})

describe('routing through an endpoint-served catalog', () => {
  /** A plugin instance whose only route serves its models from the endpoint it names. */
  async function routeThrough(baseURL: string, extra: Record<string, unknown> = {}): Promise<Context> {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': { api: 'openai-completions', baseURL, apiKeyEnv: 'PI_TEST_KEY', ...extra },
      },
    })
    return ctx
  }

  it('reads the gateway listing and streams through the model it named', async () => {
    const server = await mockServer([
      { body: JSON.stringify({ data: [{ id: 'gateway-large', contextWindow: 65536, maxTokens: 4096 }] }) },
      { events: textEvents },
    ])
    const ctx = await routeThrough(server.url)

    const result = await assemble(ctx, { provider: 'acme-gateway', model: 'gateway-large', messages: [] })

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
    expect(server.paths).toEqual(['/models', '/chat/completions'])
    await expect(ctx.llm.listModels('acme-gateway')).resolves.toEqual([
      { provider: 'acme-gateway', id: 'gateway-large', name: 'gateway-large', inputModalities: ['text'] },
    ])
    // The request above already read it; listing must not read it again.
    expect(server.paths).toHaveLength(2)
  })

  it('abandons a reading the route\'s own timeout exceeds', async () => {
    const ctx = await routeThrough(await silentListingServer(), { timeoutMs: 25 })

    await expect(ctx.llm.resolveModelInfo('acme-gateway', 'gateway-large'))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('reads an AMAX route through its configured credential, not an absent ambient key', async () => {
    vi.stubEnv(AMAX_API_KEY_ENV, '')
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ body: JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }) }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { amax: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } },
    })

    await expect(ctx.llm.listModels('amax')).resolves.toEqual([
      { provider: 'amax', id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', inputModalities: ['text'] },
    ])
    expect(server.headers[0]?.authorization).toBe('Bearer test-key')
  })
})
