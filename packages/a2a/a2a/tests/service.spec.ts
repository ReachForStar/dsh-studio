import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { A2AService, apply, Config, replyOf, type Config as A2AConfig } from '../src/index.ts'
import type { A2ABus } from '../src/bus.ts'
import { createA2AServer } from '../src/server.ts'
import type { A2ATask, AgentCard, BusEvent, BusTask } from '../src/schema.ts'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** 起一个只回固定响应的 HTTP 服务，用来构造协议异常分支。 */
async function rawServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
}

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
    expect(Config({})).toMatchObject({ peers: {} })
    // 组合总是给出空的 bridge 段；空段等于这个部署不派发到任何桥
    expect(Config({}).bridge).toEqual({})
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

/** 桥配置文件：三个 agent 的端口与 skill 映射。 */
function bridgeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-a2a-service-'))
  dirs.push(dir)
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify({
    agents: { pi: { port: 9310 }, 'claude-code': { port: 9320 }, opencode: { port: 9330 } },
    piSkillTools: { 'code-dev': [], analysis: [] },
    claudeSkillTools: { 'code-review': [], coding: [] },
    opencodeSkillAgents: { analysis: 'bridge-review' },
    bus: { bootstrapServers: ['127.0.0.1:9092'] },
  }))
  return path
}

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** 记录投递、可注入事件的假总线，用来在不起 Kafka 的前提下测总线分支。 */
class FakeBus {
  readonly produced: BusTask[] = []
  readonly groups: string[] = []
  private handler: ((event: BusEvent) => void) | undefined
  ensureTopicsCalls = 0
  stopped = 0

  async ensureTopics(): Promise<void> {
    this.ensureTopicsCalls += 1
  }

  async produceTask(task: BusTask): Promise<void> {
    this.produced.push(task)
  }

  async produceEvent(): Promise<void> {
    throw new Error('unused')
  }

  async consumeEvents(groupId: string, handler: (event: BusEvent) => void): Promise<{ stop: () => Promise<void> }> {
    this.groups.push(groupId)
    this.handler = handler
    return {
      stop: async (): Promise<void> => {
        this.stopped += 1
      },
    }
  }

  async consumeTasks(): Promise<{ stop: () => Promise<void> }> {
    throw new Error('unused')
  }

  async close(): Promise<void> {
    throw new Error('unused')
  }

  /** 向订阅方推一条事件。 */
  emit(event: BusEvent): void {
    if (this.handler === undefined) throw new Error('no event consumer registered')
    this.handler(event)
  }
}

/** 用假总线替换真实 Kafka 的服务。 */
class BusBackedService extends A2AService {
  constructor(ctx: Context, config: A2AConfig, private readonly injected: FakeBus) {
    super(ctx, config)
  }

  protected override busOf(): A2ABus {
    return this.injected as unknown as A2ABus
  }
}

describe('A2AService 桥配置与委派', () => {
  it('从桥配置派生三个 agent 的对等端，显式配置的同名对等端优先', () => {
    const service = serviceOf({
      bridge: { configPath: bridgeFile() },
      peers: { 'claude-code': { url: 'http://override/' } },
    })
    expect(service.list()).toEqual(['pi', 'claude-code', 'opencode'])
    expect(service.resolve('pi')).toMatchObject({ url: 'http://127.0.0.1:9310/' })
    expect(service.resolve('claude-code')).toEqual({ url: 'http://override/' })
    expect(service.bridgeConfig?.agents.opencode.port).toBe(9330)
    expect(service.skills('claude-code')).toEqual(['code-review', 'coding'])
    expect(service.skills('nobody')).toEqual([])
    expect(service.skills('opencode')).toEqual(['analysis'])
  })

  it('未配置桥时不暴露桥配置，也没有派生的对等端', () => {
    const service = serviceOf({})
    expect(service.bridgeConfig).toBeUndefined()
    expect(service.list()).toEqual([])
    expect(service.skills('pi')).toEqual([])
  })

  it('没有桥、或桥不跑该 agent 时直接报错', async () => {
    await expect(serviceOf({}).dispatch({ agent: 'pi', skill: 'code-dev', text: 'x' }))
      .rejects.toThrow(/no bridge deployment is configured/)
    await expect(serviceOf({ bridge: { configPath: bridgeFile() } }).dispatch({ agent: 'gemini', skill: 's', text: 'x' }))
      .rejects.toThrow(/bridge runs pi, claude-code, opencode, not "gemini"/)
  })

  it('直连派发把 skill 与 workspace 放进消息元数据并回传答案', async () => {
    const seen: Record<string, unknown>[] = []
    const server = createA2AServer({
      card: CARD,
      executor: {
        onMessage: (exec) => {
          seen.push(exec.metadata ?? {})
          exec.sink.appendArtifact('reply', 'reply', '收到', true)
          return Promise.resolve()
        },
      },
      port: 0,
    })
    await server.ready
    const address = server.server.address()
    if (typeof address !== 'object' || address === null) throw new Error('no address')
    const service = serviceOf({
      bridge: { configPath: bridgeFile() },
      peers: { 'claude-code': { url: `http://127.0.0.1:${String(address.port)}/` } },
    })
    try {
      const reply = await service.dispatch({
        agent: 'claude-code',
        skill: 'code-review',
        text: '审查',
        workspace: 'D:/w',
      })
      expect(reply).toMatchObject({ agent: 'claude-code', skill: 'code-review', mode: 'direct', text: '收到', state: 'TASK_STATE_COMPLETED' })
      expect(seen[0]).toEqual({ skill: 'code-review', workspace: 'D:/w' })
    } finally {
      await server.close()
    }
  })

  it('直连派发在对端任务被清理时用流内的任务兜底', async () => {
    const url = await rawServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += String(chunk) })
      req.on('end', () => {
        const body = JSON.parse(raw) as { method: string }
        if (body.method === 'GetTask') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32001, message: 'Task not found' } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const task = { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_SUBMITTED', timestamp: 'now' }, artifacts: [], history: [] }
        res.write(`data: ${JSON.stringify({ task })}\n\n`)
        res.write(`data: ${JSON.stringify({ artifactUpdate: { taskId: 't1', contextId: 'c1', artifact: { artifactId: 'reply', parts: [{ text: '流内答案' }] } } })}\n\n`)
        res.write(`data: ${JSON.stringify({ statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED', timestamp: 'now' } } })}\n\n`)
        res.end()
      })
    })
    const service = serviceOf({
      bridge: { configPath: bridgeFile() },
      peers: { 'claude-code': { url } },
    })
    const reply = await service.dispatch({ agent: 'claude-code', skill: 'code-review', text: 'x' })
    expect(reply).toMatchObject({ text: '流内答案', state: 'TASK_STATE_COMPLETED', taskId: 't1' })
  })

  it('直连派发在流没有任务时报错', async () => {
    const url = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end()
    })
    const service = serviceOf({ bridge: { configPath: bridgeFile() }, peers: { 'claude-code': { url } } })
    await expect(service.dispatch({ agent: 'claude-code', skill: 'coding', text: 'x' }))
      .rejects.toThrow(/stream ended without a task/)
  })

  it('总线派发默认发完即返回，带 wait 时等到终态', async () => {
    const bus = new FakeBus()
    const service = new BusBackedService(new Context(), { bridge: { configPath: bridgeFile() } }, bus)
    const dispatched = await service.dispatch({
      agent: 'opencode',
      skill: 'analysis',
      text: '拆计划',
      workspace: 'D:/w',
      contextId: 'ctx-1',
      mode: 'bus',
    })
    expect(dispatched).toMatchObject({ mode: 'bus', state: 'TASK_STATE_SUBMITTED', contextId: 'ctx-1', text: '' })
    const task = bus.produced[0]
    expect(task).toMatchObject({
      schema: 'a2a.task/1',
      to: 'opencode',
      from: 'dsh',
      skill: 'analysis',
      contextId: 'ctx-1',
      input: { text: '拆计划', workspace: 'D:/w' },
      attempt: 1,
    })
    expect(bus.ensureTopicsCalls).toBe(1)
    expect(bus.stopped).toBe(1)

    const waiting = service.dispatch({ agent: 'opencode', skill: 'analysis', text: '再拆', mode: 'bus', wait: true, timeoutMs: 5_000 })
    await vi.waitFor(() => { expect(bus.produced).toHaveLength(2) })
    const second = bus.produced[1]
    if (second === undefined) throw new Error('task was not published')
    bus.emit({ schema: 'a2a.event/1', taskId: second.taskId, contextId: second.contextId, from: 'opencode', type: 'artifact-update', text: '第一段', ts: 1 })
    bus.emit({ schema: 'a2a.event/1', taskId: second.taskId, contextId: second.contextId, from: 'opencode', type: 'terminal', state: 'TASK_STATE_COMPLETED', ts: 2 })
    await expect(waiting).resolves.toMatchObject({ text: '第一段', state: 'TASK_STATE_COMPLETED' })
  })
  it('总线等待超时后保留已见文本与工作态', async () => {
    const bus = new FakeBus()
    const service = new BusBackedService(new Context(), { bridge: { configPath: bridgeFile() } }, bus)
    const waiting = service.dispatch({ agent: 'pi', skill: 'code-dev', text: 'x', mode: 'bus', wait: true, timeoutMs: 1 })
    await vi.waitFor(() => { expect(bus.produced).toHaveLength(1) })
    const task = bus.produced[0]
    if (task === undefined) throw new Error('task was not published')
    bus.emit({ schema: 'a2a.event/1', taskId: task.taskId, contextId: task.contextId, from: 'pi', type: 'artifact-update', text: '半截', ts: 1 })
    await expect(waiting).resolves.toMatchObject({ text: '半截', state: 'TASK_STATE_WORKING' })
  })

  it('总线终态失败时把错误文本当作答案', async () => {
    const bus = new FakeBus()
    const service = new BusBackedService(new Context(), { bridge: { configPath: bridgeFile() } }, bus)
    const waiting = service.dispatch({ agent: 'pi', skill: 'code-dev', text: 'x', mode: 'bus', wait: true, timeoutMs: 5_000 })
    await vi.waitFor(() => { expect(bus.produced).toHaveLength(1) })
    const task = bus.produced[0]
    if (task === undefined) throw new Error('task was not published')
    bus.emit({ schema: 'a2a.event/1', taskId: task.taskId, contextId: task.contextId, from: 'pi', type: 'terminal', state: 'TASK_STATE_FAILED', error: 'fetch failed', ts: 2 })
    await expect(waiting).resolves.toMatchObject({ text: 'fetch failed', state: 'TASK_STATE_FAILED' })
  })

  it('直连派发按帧转发进度：状态变化与工件文本各报一次', async () => {
    const url = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const task = { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_SUBMITTED', timestamp: 'now' }, artifacts: [], history: [] }
      res.write(`data: ${JSON.stringify({ task })}\n\n`)
      res.write(`data: ${JSON.stringify({ statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING', timestamp: 'now' } } })}\n\n`)
      res.write(`data: ${JSON.stringify({ artifactUpdate: { taskId: 't1', contextId: 'c1', artifact: { artifactId: 'reply', parts: [{ text: '第一段' }] } } })}\n\n`)
      res.write(`data: ${JSON.stringify({ artifactUpdate: { taskId: 't1', contextId: 'c1', artifact: { artifactId: 'reply', parts: [{ text: '第二段' }] } } })}\n\n`)
      res.write(`data: ${JSON.stringify({ statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING', timestamp: 'now' } } })}\n\n`)
      res.write(`data: ${JSON.stringify({ statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED', timestamp: 'now' } } })}\n\n`)
      res.end()
    })
    const service = serviceOf({ bridge: { configPath: bridgeFile() }, peers: { 'claude-code': { url } } })
    const progress: { state?: string; text: string }[] = []
    const reply = await service.dispatch({
      agent: 'claude-code',
      skill: 'code-review',
      text: 'x',
      onProgress: (report) => { progress.push(report) },
    })
    expect(reply.state).toBe('TASK_STATE_COMPLETED')
    expect(progress).toEqual([
      { state: 'TASK_STATE_WORKING', text: '' },
      { state: 'TASK_STATE_WORKING', text: '第一段' },
      { state: 'TASK_STATE_WORKING', text: '第一段第二段' },
      { state: 'TASK_STATE_COMPLETED', text: '第一段第二段' },
    ])
  })

  it('直连派发在终态无工件时用状态消息补文本并上报', async () => {
    const url = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const task = { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_SUBMITTED', timestamp: 'now' }, artifacts: [], history: [] }
      res.write(`data: ${JSON.stringify({ task })}\n\n`)
      res.write(`data: ${JSON.stringify({ statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_FAILED', timestamp: 'now', message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: '失败原因' }] } } } })}\n\n`)
      res.end()
    })
    const service = serviceOf({ bridge: { configPath: bridgeFile() }, peers: { 'claude-code': { url } } })
    const progress: { state?: string; text: string }[] = []
    await service.dispatch({
      agent: 'claude-code',
      skill: 'code-review',
      text: 'x',
      onProgress: (report) => { progress.push(report) },
    })
    expect(progress.at(-1)).toEqual({ state: 'TASK_STATE_FAILED', text: '失败原因' })
  })

  it('总线派发按事件转发进度，未配置回调时不报错', async () => {
    const bus = new FakeBus()
    const service = new BusBackedService(new Context(), { bridge: { configPath: bridgeFile() } }, bus)
    const progress: { state?: string; text: string }[] = []
    const waiting = service.dispatch({ agent: 'pi', skill: 'code-dev', text: 'x', mode: 'bus', wait: true, timeoutMs: 5_000, onProgress: (report) => { progress.push(report) } })
    await vi.waitFor(() => { expect(bus.produced).toHaveLength(1) })
    const task = bus.produced[0]
    if (task === undefined) throw new Error('task was not published')
    bus.emit({ schema: 'a2a.event/1', taskId: task.taskId, contextId: task.contextId, from: 'pi', type: 'status-update', state: 'TASK_STATE_WORKING', ts: 1 })
    bus.emit({ schema: 'a2a.event/1', taskId: task.taskId, contextId: task.contextId, from: 'pi', type: 'artifact-update', text: '第一段', ts: 2 })
    bus.emit({ schema: 'a2a.event/1', taskId: task.taskId, contextId: task.contextId, from: 'pi', type: 'terminal', state: 'TASK_STATE_COMPLETED', ts: 3 })
    await expect(waiting).resolves.toMatchObject({ text: '第一段', state: 'TASK_STATE_COMPLETED' })
    expect(progress).toEqual([
      { state: 'TASK_STATE_WORKING', text: '' },
      { state: 'TASK_STATE_WORKING', text: '第一段' },
      { state: 'TASK_STATE_COMPLETED', text: '第一段' },
    ])

    const second = new BusBackedService(new Context(), { bridge: { configPath: bridgeFile() } }, new FakeBus())
    const reply = await second.dispatch({ agent: 'pi', skill: 'code-dev', text: 'x', mode: 'bus' })
    expect(reply.state).toBe('TASK_STATE_SUBMITTED')
  })
})
