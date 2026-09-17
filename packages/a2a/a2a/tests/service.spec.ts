import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { A2AService, apply, Config, replyOf, type Config as A2AConfig } from '../src/index.ts'
import { createA2AServer } from '../src/server.ts'
import type { A2ATask, AgentCard } from '../src/schema.ts'

const CARD: AgentCard = {
  name: 'peer-agent',
  description: 'peer',
  version: '1.0.0',
  supportedInterfaces: [{ url: 'http://127.0.0.1:0/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'default', name: 's', description: 'd', tags: [] }],
}

async function peer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createA2AServer({
    card: CARD,
    executor: {
      onMessage: (ctx) => {
        ctx.sink.appendArtifact('reply', 'reply', `回答：${ctx.text}`, true)
        return Promise.resolve()
      },
    },
    port: 0,
  })
  await server.ready
  const address = server.server.address()
  if (typeof address !== 'object' || address === null) throw new Error('no address')
  return { url: `http://127.0.0.1:${String(address.port)}/`, close: () => server.close() }
}

function serviceOf(config: A2AConfig): A2AService {
  const ctx = new Context()
  return new A2AService(ctx, config)
}

describe('A2AService 配置', () => {
  it('Config 默认没有对等端', () => {
    expect(Config({})).toEqual({ peers: {} })
  })

  it('拒绝空名字与空 url', () => {
    expect(() => new A2AService(new Context(), { peers: { '': { url: 'http://x/' } } })).toThrow(/peer names must be non-empty/)
    expect(() => new A2AService(new Context(), { peers: { a: { url: '' } } })).toThrow(/peer "a" has an empty url/)
  })

  it('按名字解析已配置的对等端，URL 直接放行，其余报错', () => {
    const service = serviceOf({ peers: { reviewer: { url: 'http://reviewer/', apiKey: 'k', timeoutMs: 5 } } })
    expect(service.list()).toEqual(['reviewer'])
    expect(service.resolve('reviewer')).toEqual({ url: 'http://reviewer/', apiKey: 'k', timeoutMs: 5 })
    expect(service.resolve('http://other/')).toEqual({ url: 'http://other/' })
    expect(() => service.resolve('nope')).toThrow(/no A2A peer named "nope"; configured peers are reviewer/)
    expect(() => serviceOf({}).resolve('nope')).toThrow(/configured peers are \(none\)/)
    expect(() => service.resolve('')).toThrow(/must be named or given a URL/)
  })

  it('apply 注册 ctx.a2a', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ apply }, { peers: {} })
    await fiber.await()
    expect(ctx.a2a.list()).toEqual([])
    await fiber.dispose()
  })
})

describe('A2AService 调用', () => {
  it('发送消息并读回答案，inspect 列出卡片标题', async () => {
    const target = await peer()
    try {
      const service = serviceOf({ peers: { peer: { url: target.url } } })
      const reply = await service.send({ peer: 'peer', text: '你好' })
      expect(reply).toMatchObject({ text: '回答：你好', state: 'TASK_STATE_COMPLETED' })
      expect(reply.taskId).toBeDefined()
      expect(reply.contextId).toBeDefined()
      expect(await service.card('peer')).toMatchObject({ name: 'peer-agent' })
      expect(await service.inspect()).toEqual([{ name: 'peer', url: target.url, title: 'peer-agent' }])
    } finally {
      await target.close()
    }
  })

  it('对不可达的对等端报错，并把失败放在 inspect 行里', async () => {
    const service = serviceOf({ peers: { dead: { url: 'http://127.0.0.1:1/' } } })
    await expect(service.send({ peer: 'dead', text: 'x' })).rejects.toThrow()
    const [row] = await service.inspect()
    expect(row?.name).toBe('dead')
    expect(row?.error).toBeDefined()
  })

  it('继续对话时带上 contextId', async () => {
    const target = await peer()
    try {
      const service = serviceOf({ peers: { peer: { url: target.url } } })
      const first = await service.send({ peer: 'peer', text: '一' })
      const second = await service.send({ peer: 'peer', text: '二', ...first.contextId === undefined ? {} : { contextId: first.contextId } })
      expect(second.contextId).toBe(first.contextId)
      expect(second.taskId).not.toBe(first.taskId)
    } finally {
      await target.close()
    }
  })

  it('把 cardPath 与 timeoutMs 透传给客户端', async () => {
    const target = await peer()
    try {
      const service = serviceOf({ peers: { peer: { url: target.url, cardPath: '/.well-known/agent-card.json', timeoutMs: 1000 } } })
      expect((await service.card('peer')).name).toBe('peer-agent')
      expect((await service.send({ peer: 'peer', text: '一' })).text).toBe('回答：一')
    } finally {
      await target.close()
    }
  })

  it('inspect 支持取消信号', async () => {
    const target = await peer()
    try {
      const service = serviceOf({ peers: { peer: { url: target.url } } })
      const controller = new AbortController()
      await expect(service.inspect(controller.signal)).resolves.toHaveLength(1)
      controller.abort()
      const [row] = await service.inspect(controller.signal)
      expect(row?.error).toBeDefined()
    } finally {
      await target.close()
    }
  })

  it('取消信号传到调用', async () => {
    const target = await peer()
    try {
      const service = serviceOf({ peers: { peer: { url: target.url } } })
      const controller = new AbortController()
      controller.abort()
      await expect(service.send({ peer: 'peer', text: '一', signal: controller.signal })).rejects.toThrow()
    } finally {
      await target.close()
    }
  })
})

describe('replyOf', () => {
  const base = { id: 't', contextId: 'c', status: { state: 'TASK_STATE_COMPLETED', timestamp: 'now' }, artifacts: [], history: [] } as unknown as A2ATask

  it('优先取工件文本', () => {
    expect(replyOf({ ...base, artifacts: [{ artifactId: 'reply', parts: [{ text: 'a' }, { url: 'x' }] }] }))
      .toMatchObject({ text: 'a', taskId: 't', contextId: 'c', state: 'TASK_STATE_COMPLETED' })
  })

  it('其次取状态消息', () => {
    expect(replyOf({
      ...base,
      status: { state: 'TASK_STATE_FAILED', timestamp: 'now', message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: '失败原因' }] } },
    })).toMatchObject({ text: '失败原因', state: 'TASK_STATE_FAILED' })
  })

  it('最后取历史里最后一条 agent 文本', () => {
    expect(replyOf({
      ...base,
      history: [
        { messageId: '1', role: 'ROLE_AGENT', parts: [{ text: '旧' }] },
        { messageId: '2', role: 'ROLE_USER', parts: [{ text: '用户' }] },
        { messageId: '3', role: 'ROLE_AGENT', parts: [{ text: '新' }] },
      ],
    })).toMatchObject({ text: '新' })
  })

  it('什么都没有时给出空答案', () => {
    expect(replyOf(base)).toMatchObject({ text: '' })
  })
})
