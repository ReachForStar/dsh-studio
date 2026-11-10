/** Host entry: validated deployment settings and the one route they configure. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { Config, MAX_PAPER_BYTES, PAPER_LIBRARY_DIR, apply } from '../src/index.ts'
import { PAPER_READER_ROUTE, PAPER_TRANSLATE_ROUTE } from '../src/route.ts'

it('defaults to the profile paper library and the 100 MB upload bound', () => {
  expect(Config({})).toEqual({ directory: PAPER_LIBRARY_DIR, maxBytes: MAX_PAPER_BYTES })
  expect(Config({ directory: '/papers', maxBytes: 1024 })).toEqual({ directory: '/papers', maxBytes: 1024 })
})

it('registers the library prefix and withdraws it on disposal', async () => {
  const ctx = new Context()
  const routes: Array<{ kind: string; path: string; handler: unknown }> = []
  ctx.provide('webServer', {
    register: (route: { kind: string; path: string; handler: unknown }) => {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  } as never)
  const fiber = ctx.plugin({ apply }, Config({}))
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  expect(routes.map(route => [route.kind, route.path])).toEqual([['prefix', PAPER_READER_ROUTE]])
  expect(typeof routes[0]?.handler).toBe('function')
  await fiber.dispose()
  expect(routes).toEqual([])
})

it('serves the configured directory through the registered handler', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-paper-host-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const ctx = new Context()
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined
  ctx.provide('webServer', {
    register: (route: { handler: (req: unknown, res: unknown) => Promise<void> }) => {
      handler = route.handler
      return () => {}
    },
  } as never)
  const fiber = ctx.plugin({ apply }, Config({ directory }))
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()

  let status = 0
  let body = ''
  await handler?.(
    { url: `${PAPER_READER_ROUTE}/papers`, method: 'GET', on() { return this } },
    { writeHead(next: number) { status = next }, end(payload: string) { body = payload } },
  )
  expect(status).toBe(200)
  expect(JSON.parse(body)).toEqual({ papers: [] })
})

it('adds the translation route once an llm service is composed', async () => {
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [{ id: 'gateway' }],
    listModels: async () => [{ id: 'model', name: 'Model' }],
    stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: '译' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  } as never)
  const routes: Array<{
    kind: string
    path: string
    handler: (req: unknown, res: unknown) => Promise<void>
  }> = []
  ctx.provide('webServer', {
    register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  } as never)
  const fiber = ctx.plugin({ apply }, Config({}))
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  expect(routes.map(route => [route.kind, route.path]).sort()).toEqual([
    ['prefix', PAPER_READER_ROUTE], ['prefix', PAPER_TRANSLATE_ROUTE],
  ].sort())

  const body = Buffer.from(JSON.stringify({ text: 'hello', target: 'zh' }))
  const chunks: string[] = []
  let status = 0
  const response = {
    writeHead(next: number) { status = next },
    write(text: string) { chunks.push(text) },
    end() {},
    on() { return this },
  }
  await routes.find(route => route.path === PAPER_TRANSLATE_ROUTE)?.handler({
    url: PAPER_TRANSLATE_ROUTE,
    method: 'POST',
    on(event: 'data' | 'end' | 'error', listener: (chunk?: Buffer) => void) {
      if (event === 'data') listener(body)
      if (event === 'end') listener()
      return this
    },
  }, response)
  expect(status).toBe(200)
  expect(chunks.map(line => JSON.parse(line) as unknown)).toEqual([
    { type: 'delta', text: '译' },
    { type: 'finish' },
  ])

  await fiber.dispose()
  expect(routes).toEqual([])
})
