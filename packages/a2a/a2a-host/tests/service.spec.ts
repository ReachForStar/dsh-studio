import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentCard } from '@reachforstar/dsh-a2a'
import { apply, A2AHostService, Config } from '../src/index.ts'

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.()
})

/** 只提供 A2A 主机用到的那两个方法。 */
interface SessionControllerStub {
  create: () => Promise<{ sessionId: string }>
  prompt: () => Promise<{ accepted: true }>
  cancel: () => { accepted: true }
  follow: () => AsyncIterable<never>
}

function sessionController(): SessionControllerStub {
  return {
    create: () => Promise.resolve({ sessionId: 's' }),
    prompt: () => Promise.resolve({ accepted: true }),
    cancel: () => ({ accepted: true }),
    follow: () => (async function* () {})() as AsyncIterable<never>,
  }
}

async function host(config: Parameters<typeof apply>[1]): Promise<{ ctx: Context; service: A2AHostService }> {
  const ctx = new Context()
  ctx.provide('sessionController', sessionController() as never)
  const fiber = ctx.plugin({ apply, inject: ['sessionController'] }, config)
  await fiber.await()
  disposers.push(async () => { await fiber.dispose() })
  const service = ctx.reflect.get('a2aHost') as A2AHostService | undefined
  if (service === undefined) throw new Error('a2aHost was not registered')
  return { ctx, service }
}

describe('A2AHostService', () => {
  it('绑定端口、按真实端口改写卡片地址并对外服务', async () => {
    const { service } = await host({ port: 0, host: '127.0.0.1' })
    expect(service.listening).toBe(true)
    expect(service.port).toBeGreaterThan(0)
    expect(service.url).toBe(`http://127.0.0.1:${String(service.port)}/`)
    const card = await (await fetch(`${service.url}.well-known/agent-card.json`)).json() as AgentCard
    expect(card.name).toBe('dsh-studio')
    expect(card.supportedInterfaces[0]?.url).toBe(service.url)
    expect(card.capabilities.streaming).toBe(true)
    const health = await (await fetch(`${service.url}health`)).json() as { ok: boolean }
    expect(health.ok).toBe(true)
  })

  it('配置了对外地址时按配置公布，不做改写', async () => {
    const { service } = await host({ port: 0, url: 'https://agents.example/a2a/' })
    expect(service.url).toBe('https://agents.example/a2a/')
    const card = await (await fetch(`http://127.0.0.1:${String(service.port)}/.well-known/agent-card.json`)).json() as AgentCard
    expect(card.supportedInterfaces[0]?.url).toBe('https://agents.example/a2a/')
  })

  it('配置了 apiKey 时要求凭据，并把它写进卡片', async () => {
    const { service } = await host({ port: 0, apiKey: 'secret' })
    const card = await (await fetch(`${service.url}.well-known/agent-card.json`)).json() as AgentCard
    expect(card.securityRequirements).toEqual([{ schemes: { apiKey: { list: [] } } }])
    const rejected = await fetch(service.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'ListTasks', params: {} }),
    })
    expect(rejected.status).toBe(401)
  })

  it('自带卡片身份可覆盖，卸载后停止监听', async () => {
    const { service } = await host({
      port: 0,
      card: {
        name: 'my-agent',
        description: '自定义',
        version: '9.9.9',
        documentationUrl: 'https://example/docs',
        skills: [{ id: 'code', name: '代码', description: '编写代码', tags: ['coding'] }],
      },
    })
    expect(service.card).toMatchObject({
      name: 'my-agent',
      description: '自定义',
      version: '9.9.9',
      documentationUrl: 'https://example/docs',
      skills: [{ id: 'code', name: '代码', description: '编写代码', tags: ['coding'] }],
    })
    const port = service.port
    await disposers.pop()?.()
    expect(service.listening).toBe(false)
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toThrow()
  })
})

describe('A2AHostService 启动路径', () => {
  it('全部选项都给定时按配置建执行器与监听', async () => {
    const { service } = await host({
      port: 0,
      host: '0.0.0.0',
      cwd: '/srv/work',
      agentPreset: 'dev',
      turnTimeoutMs: 1000,
      apiKey: 'secret',
      card: { name: 'full', documentationUrl: 'https://example/docs' },
    })
    expect(service.url).toBe(`http://127.0.0.1:${String(service.port)}/`)
    expect(service.card.documentationUrl).toBe('https://example/docs')
    expect(service.port).toBeGreaterThan(0)
  })

  it('只给最小配置时用默认主机与端口占位', async () => {
    const { service } = await host({ port: 0 })
    expect(service.url).toBe(`http://127.0.0.1:${String(service.port)}/`)
    expect(service.card.name).toBe('dsh-studio')
  })

  it('端口被占用时启动失败并把原因交给等待方', async () => {
    const { service: first } = await host({ port: 0 })
    const busy = first.port ?? 0
    const ctx = new Context()
    ctx.provide('sessionController', sessionController() as never)
    const failing = new A2AHostService(ctx, { port: busy, host: '127.0.0.1' })
    await expect(failing.start()).rejects.toThrow(/EADDRINUSE/)
    await expect(failing.ready).rejects.toThrow(/EADDRINUSE/)
    expect(failing.listening).toBe(true)
  })

  it('按类插件挂载时由 init 完成绑定', async () => {
    const ctx = new Context()
    ctx.provide('sessionController', sessionController() as never)
    const fiber = ctx.plugin(A2AHostService, { port: 0, host: '127.0.0.1' })
    await fiber.await()
    const service = ctx.reflect.get('a2aHost') as A2AHostService
    expect(service.port).toBeGreaterThan(0)
    await fiber.dispose()
    expect(service.listening).toBe(false)
  })
})

describe('Config', () => {
  it('给出可直接启动的默认值', () => {
    const config = Config({})
    expect(config).toMatchObject({ host: '127.0.0.1', port: 9310, apiKey: '', turnTimeoutMs: 1_800_000 })
    expect(config.card).toMatchObject({ name: 'dsh-studio', version: '0.1.0' })
    expect(config.card?.skills).toHaveLength(1)
  })
})
