import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createA2ARequestHandler, createA2AServer, teeSink, type A2AExecutor, type A2AServer } from '../src/server.ts'
import type { AgentCard, TaskPushNotificationConfig } from '../src/schema.ts'
import { TaskStore } from '../src/task-store.ts'

const CARD: AgentCard = {
  name: 'test-agent',
  description: 'test',
  version: '1.0.0',
  supportedInterfaces: [{ url: 'http://127.0.0.1:0/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'default', name: 's', description: 'd', tags: [] }],
}

interface Harness {
  readonly url: string
  readonly server: A2AServer
  close(): Promise<void>
}

const running: Harness[] = []

/** 声明支持推送通知的卡片：四个配置方法只在这个能力下开放。 */
const PUSH_CARD: AgentCard = {
  ...CARD,
  capabilities: { streaming: true, pushNotifications: true },
}

/** 一条投递到 webhook 的通知。 */
interface WebhookDelivery {
  readonly headers: http.IncomingHttpHeaders
  readonly body: Record<string, unknown>
}

interface Webhook {
  url: string
  readonly deliveries: WebhookDelivery[]
  /** 接下来多少次投递回应 5xx；用完之前不回应成功。 */
  failures: number
  /** 成功投递时回应的状态码，用于按「不可重试」分类。 */
  status: number
  stop(): Promise<void>
}

const hooks: Webhook[] = []

/** 在本机起一个接收推送的 webhook。 */
async function webhook(): Promise<Webhook> {
  const deliveries: WebhookDelivery[] = []
  const hook: Webhook = {
    url: '',
    deliveries,
    failures: 0,
    status: 200,
    stop: () => Promise.resolve(),
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += String(chunk) })
    req.on('end', () => {
      deliveries.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> })
      if (hook.failures > 0) {
        hook.failures -= 1
        res.writeHead(500)
        res.end('boom')
        return
      }
      res.writeHead(hook.status)
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  hook.url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}/webhook`
  hook.stop = () => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })
  hooks.push(hook)
  return hook
}

/** 取一个 RPC 答复里的任务 id。 */
function taskIdOf(response: { body: Record<string, unknown> }): string {
  return (response.body.result as { task: { id: string } }).task.id
}

async function start(
  executor: A2AExecutor,
  options: {
    apiKey?: string
    card?: AgentCard
    maxBodyBytes?: number
    store?: TaskStore
    taskTimeoutMs?: number
    onError?: (message: string, error: unknown) => void
  } = {},
): Promise<Harness> {
  const server = createA2AServer({
    card: options.card ?? CARD,
    executor,
    port: 0,
    apiKey: options.apiKey ?? '',
    ...options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes },
    ...options.store === undefined ? {} : { store: options.store },
    ...options.taskTimeoutMs === undefined ? {} : { taskTimeoutMs: options.taskTimeoutMs },
    ...options.onError === undefined ? {} : { onError: options.onError },
  })
  await server.ready
  const address = server.server.address()
  if (typeof address !== 'object' || address === null) throw new Error('no address')
  const harness: Harness = {
    url: `http://127.0.0.1:${String(address.port)}/`,
    server,
    close: () => server.close(),
  }
  running.push(harness)
  return harness
}

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close()
  while (hooks.length > 0) await hooks.pop()?.stop()
})

async function call(
  url: string,
  body: unknown,
  options: { key?: string; raw?: string; version?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'A2A-Version': options.version ?? '1.0',
      ...options.key === undefined ? {} : { 'X-Api-Key': options.key },
    },
    body: options.raw ?? JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

function rpc(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: '1', method, ...params === undefined ? {} : { params } }
}

function message(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text }], ...extra } }
}

/** SSE 帧之间的空行分隔符。 */
const SEPARATOR = String.fromCharCode(10, 10)

/** 取流式帧里的任务状态与工件，供逐字段断言用。 */
function stateOf(frame: unknown): string | undefined {
  return (frame as { statusUpdate?: { status?: { state?: string } } }).statusUpdate?.status?.state
}

function artifactOf(frame: unknown): unknown {
  return (frame as { artifactUpdate?: { artifact?: unknown } }).artifactUpdate?.artifact
}

/** 逐帧读取的 SSE 连接：先拿到某一帧，再决定是否放行后台执行。 */
async function openStream(url: string, body: unknown): Promise<{ next(): Promise<unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify(body),
  })
  if (response.body === null) throw new Error('no stream body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async next() {
      while (true) {
        const end = buffer.indexOf(SEPARATOR)
        if (end >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + SEPARATOR.length)
          if (frame.length > 0) return JSON.parse(frame.replace('data: ', '')) as unknown
          continue
        }
        const { done, value } = await reader.read()
        if (done) return undefined
        buffer += decoder.decode(value, { stream: true })
      }
    },
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not reached in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function stream(url: string, body: unknown): Promise<unknown[]> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return text.split('\n\n').filter(frame => frame.length > 0).map(frame => JSON.parse(frame.replace('data: ', '')) as unknown)
}

/** 立即回一条答案的执行器。 */
function instant(text = 'ok'): A2AExecutor {
  return {
    onMessage: (ctx) => {
      ctx.sink.appendArtifact('reply', 'reply', text, true)
      return Promise.resolve()
    },
  }
}

describe('A2A 服务端发现与基础协议', () => {
  it('公开提供健康检查与 agent card，其它方法返回 405', async () => {
    const harness = await start(instant())
    const health = await fetch(`${harness.url}health`)
    expect(await health.json()).toEqual({ ok: true, agent: 'test-agent' })
    const card = await fetch(`${harness.url}.well-known/agent-card.json`)
    expect((await card.json() as AgentCard).name).toBe('test-agent')
    const alias = await fetch(`${harness.url}.well-known/agent.json`)
    expect(alias.status).toBe(200)
    const wrong = await fetch(harness.url, { method: 'GET' })
    expect(wrong.status).toBe(405)
    expect(await wrong.json()).toEqual({ error: 'method not allowed' })
  })

  it('配置了 apiKey 时拒绝缺少凭据的调用', async () => {
    const harness = await start(instant(), { apiKey: 'secret' })
    const rejected = await call(harness.url, rpc('SendMessage', message('hi')))
    expect(rejected.status).toBe(401)
    expect(rejected.body).toMatchObject({ error: { code: -32000, message: 'unauthorized' } })
    const accepted = await call(harness.url, rpc('SendMessage', message('hi')), { key: 'secret' })
    expect(accepted.status).toBe(200)
  })

  it('解析失败与非法请求分别返回 -32700 与 -32600', async () => {
    const harness = await start(instant())
    const broken = await call(harness.url, null, { raw: '{' })
    expect(broken.body.error).toEqual({ code: -32700, message: 'Parse error' })
    const invalid = await call(harness.url, { jsonrpc: '1.0', id: 7, method: 'SendMessage' })
    expect(invalid.body).toMatchObject({ id: 7, error: { code: -32600, message: 'Invalid request' } })
    const notAnObject = await call(harness.url, [1, 2], { raw: '[1,2]' })
    expect(notAnObject.body).toMatchObject({ id: null, error: { code: -32600 } })
  })

  it('未知方法与未实现的推送配置分别返回 -32601 与 -32003', async () => {
    const harness = await start(instant())
    const unknown = await call(harness.url, rpc('Nope'))
    expect(unknown.body.error).toEqual({ code: -32601, message: 'Method not found: Nope' })
    for (const method of [
      'CreateTaskPushNotificationConfig',
      'GetTaskPushNotificationConfig',
      'ListTaskPushNotificationConfigs',
      'DeleteTaskPushNotificationConfig',
    ]) {
      const reply = await call(harness.url, rpc(method, { id: 't' }))
      expect(reply.body).toMatchObject({ error: { code: -32003, message: expect.stringContaining('push notification') as string } })
      const data = (reply.body.error as { data: { reason: string; domain: string }[] }).data
      expect(data[0]).toMatchObject({ reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED', domain: 'a2a-protocol.org' })
    }
  })

  it('请求体超限返回 413', async () => {
    const harness = await start(instant(), { maxBodyBytes: 20 })
    const reply = await call(harness.url, rpc('SendMessage', message('a'.repeat(200))))
    expect(reply.status).toBe(413)
    expect(reply.body).toMatchObject({ error: { message: 'request body too large' } })
  })

  it('缺少 parts 或 params.id 时返回 -32602', async () => {
    const harness = await start(instant())
    const noParts = await call(harness.url, rpc('SendMessage', { message: { role: 'ROLE_USER' } }))
    expect(noParts.body.error).toMatchObject({ code: -32602 })
    const noMessage = await call(harness.url, rpc('SendMessage', {}))
    expect(noMessage.body.error).toMatchObject({ code: -32602 })
    const noId = await call(harness.url, rpc('GetTask', {}))
    expect(noId.body.error).toMatchObject({ code: -32602 })
  })
})

describe('A2A 任务生命周期', () => {
  it('SendMessage 建任务、收答案，并把用户消息写进历史', async () => {
    const seen: string[] = []
    const harness = await start({
      onMessage: (ctx) => {
        seen.push(`${ctx.skill}:${ctx.text}:${JSON.stringify(ctx.metadata.skill ?? '')}`)
        ctx.sink.sendStatus('TASK_STATE_WORKING')
        ctx.sink.appendArtifact('reply', 'reply', 'hello', true)
        return Promise.resolve()
      },
    })
    const reply = await call(harness.url, rpc('SendMessage', message('hi', { metadata: { skill: 'review' } })))
    const task = (reply.body.result as {
      task: { status: { state: string }; artifacts: { parts: { text: string }[] }[]; history: unknown[] }
    }).task
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.artifacts[0]?.parts).toEqual([{ text: 'hello' }])
    expect(task.history).toHaveLength(1)
    expect(seen).toEqual(['review:hi:"review"'])
  })

  it('skill 可以来自第一个分片，缺省为 default', async () => {
    const skills: string[] = []
    const harness = await start({
      onMessage: (ctx) => {
        skills.push(ctx.skill)
        return Promise.resolve()
      },
    })
    await call(harness.url, rpc('SendMessage', {
      message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'x', metadata: { skill: 'from-part' } }] },
    }))
    await call(harness.url, rpc('SendMessage', {
      message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'y', metadata: { skill: '' } }] },
    }))
    expect(skills).toEqual(['from-part', 'default'])
  })

  it('同一 contextId 的第二次调用建新任务并复用会话', async () => {
    const contexts: string[] = []
    const harness = await start({
      onMessage: (ctx) => {
        contexts.push(ctx.contextId)
        return Promise.resolve()
      },
    })
    const first = await call(harness.url, rpc('SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'a' }], contextId: 'ctx' } }))
    const second = await call(harness.url, rpc('SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'b' }], contextId: 'ctx' } }))
    const firstTask = (first.body.result as { task: { id: string } }).task
    const secondTask = (second.body.result as { task: { id: string } }).task
    expect(contexts).toEqual(['ctx', 'ctx'])
    expect(secondTask.id).not.toBe(firstTask.id)
  })

  it('未知 taskId 与执行失败分别返回 -32001 与 FAILED', async () => {
    const harness = await start({
      onMessage: () => Promise.reject(new Error('agent exploded')),
    })
    const missing = await call(harness.url, rpc('SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'a' }], taskId: 'nope' } }))
    expect(missing.body.error).toMatchObject({ code: -32001 })
    const failed = await call(harness.url, rpc('SendMessage', message('a')))
    const task = (failed.body.result as { task: { status: { state: string; message: { parts: { text: string }[] } } } }).task
    expect(task.status.state).toBe('TASK_STATE_FAILED')
    expect(task.status.message.parts[0]?.text).toBe('agent exploded')
  })

  it('终态任务再收消息时返回 -32004，流式调用以错误帧送出', async () => {
    const harness = await start(instant())
    const sent = await call(harness.url, rpc('SendMessage', message('a')))
    const id = (sent.body.result as { task: { id: string } }).task.id
    const refused = await call(harness.url, rpc('SendMessage', message('again', { taskId: id })))
    expect(refused.body.error).toMatchObject({ code: -32004 })
    expect((refused.body.error as { data: { reason: string }[] }).data[0]).toMatchObject({ reason: 'UNSUPPORTED_OPERATION' })
    const frames = await stream(harness.url, rpc('SendStreamingMessage', message('again', { taskId: id })))
    expect(frames).toEqual([{ jsonrpc: '2.0', id: '1', error: { code: -32004, message: expect.stringContaining('cannot accept further messages') as string } }])
  })

  it('taskId 与 contextId 不匹配时返回 -32602，只给 taskId 时推断 contextId', async () => {
    let finish = (): void => {}
    const harness = await start({
      onMessage: async () => {
        await Promise.race([
          new Promise<void>((resolve) => { finish = resolve }),
          new Promise<void>((resolve) => { setTimeout(resolve, 2000).unref() }),
        ])
      },
    })
    try {
      const sent = await call(harness.url, rpc('SendMessage', { ...message('a', { contextId: 'ctx' }), configuration: { returnImmediately: true } }))
      const id = (sent.body.result as { task: { id: string } }).task.id
      const mismatched = await call(harness.url, rpc('SendMessage', message('b', { taskId: id, contextId: 'other' })))
      expect(mismatched.body.error).toMatchObject({ code: -32602 })
      // 只给 taskId 时从任务推断 contextId，不拒绝。
      const inferred = await call(harness.url, rpc('SendMessage', { ...message('c', { taskId: id }), configuration: { returnImmediately: true } }))
      expect((inferred.body.result as { task: { id: string } }).task.id).toBe(id)
    } finally {
      finish()
    }
  })

  it('执行器自己报终态时不再改成 COMPLETED', async () => {
    const harness = await start({
      onMessage: (ctx) => {
        ctx.sink.sendStatus('TASK_STATE_REJECTED', '不接')
        return Promise.resolve()
      },
    })
    const reply = await call(harness.url, rpc('SendMessage', message('a')))
    expect((reply.body.result as { task: { status: { state: string } } }).task.status.state).toBe('TASK_STATE_REJECTED')
  })

  it('returnImmediately 立即返回运行中的任务，随后可通过订阅看到终态', async () => {
    let release: (() => void) | undefined
    const harness = await start({
      onMessage: async (ctx) => {
        await Promise.race([
          new Promise<void>((resolve) => { release = resolve }),
          new Promise<void>((resolve) => { setTimeout(resolve, 1000).unref() }),
        ])
        ctx.sink.appendArtifact('reply', 'reply', 'late', true)
      },
    })
    const reply = await call(harness.url, rpc('SendMessage', { ...message('a'), configuration: { returnImmediately: true } }))
    const task = (reply.body.result as { task: { id: string; status: { state: string } } }).task
    expect(task.status.state).toBe('TASK_STATE_SUBMITTED')
    const subscription = await openStream(harness.url, rpc('SubscribeToTask', { id: task.id }))
    expect(await subscription.next()).toMatchObject({ task: { id: task.id, status: { state: 'TASK_STATE_SUBMITTED' } } })
    await waitFor(() => release !== undefined)
    release?.()
    expect(await subscription.next()).toMatchObject({ artifactUpdate: { artifact: { parts: [{ text: 'late' }] }, lastChunk: true } })
    expect(await subscription.next()).toMatchObject({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } })
    expect(await subscription.next()).toBeUndefined()
  })

  it('执行失败传入非 Error 值时写入字符串消息', async () => {
    // 协议把非 Error 的失败原因序列化成字符串，这里刻意抛一个非 Error 值。
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the protocol must serialize a non-Error rejection reason.
    const rejectWithString = (): Promise<never> => Promise.reject('plain')
    const harness = await start({ onMessage: rejectWithString })
    const reply = await call(harness.url, rpc('SendMessage', message('a')))
    expect((reply.body.result as { task: { status: { message: { parts: { text: string }[] } } } }).task.status.message.parts[0]?.text).toBe('plain')
  })
})

describe('A2A 流式与查询', () => {
  it('SendStreamingMessage 依次送出任务、状态、工件与终态', async () => {
    const harness = await start({
      onMessage: async (ctx) => {
        ctx.sink.sendStatus('TASK_STATE_WORKING')
        ctx.sink.appendArtifact('reply', 'reply', 'chunk-1')
        await Promise.resolve()
        ctx.sink.appendArtifact('reply', 'reply', 'chunk-2', true)
      },
    })
    const frames = await stream(harness.url, rpc('SendStreamingMessage', message('hi')))
    expect(frames[0]).toHaveProperty('task')
    const rest = frames.slice(1)
    expect(rest).toHaveLength(4)
    expect(stateOf(rest[0])).toBe('TASK_STATE_WORKING')
    expect(artifactOf(rest[1])).toMatchObject({ artifactId: 'reply', name: 'reply', parts: [{ text: 'chunk-1' }] })
    expect(rest[1]).toMatchObject({ artifactUpdate: { append: true } })
    expect(artifactOf(rest[2])).toMatchObject({ parts: [{ text: 'chunk-2' }] })
    expect(rest[2]).toMatchObject({ artifactUpdate: { lastChunk: true } })
    expect(stateOf(rest[3])).toBe('TASK_STATE_COMPLETED')
  })

  it('流内失败以 SSE 错误帧结束后关闭连接', async () => {
    const harness = await start(instant())
    const frames = await stream(harness.url, rpc('SendStreamingMessage', {
      message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'a' }], taskId: 'nope' },
    }))
    expect(frames).toEqual([{ jsonrpc: '2.0', id: '1', error: { code: -32001, message: 'Task not found: nope' } }])
  })

  it('SubscribeToTask 对已终态任务在开流前回 -32004', async () => {
    const harness = await start(instant())
    const sent = await call(harness.url, rpc('SendMessage', message('a')))
    const id = (sent.body.result as { task: { id: string } }).task.id
    const refused = await call(harness.url, rpc('SubscribeToTask', { id }))
    expect(refused.body.error).toMatchObject({ code: -32004 })
    expect((refused.body.error as { data: { reason: string }[] }).data[0]).toMatchObject({ reason: 'UNSUPPORTED_OPERATION' })
  })

  it('SubscribeToTask 拒绝缺少 id 的请求', async () => {
    const harness = await start(instant())
    const reply = await call(harness.url, rpc('SubscribeToTask', {}))
    expect(reply.body.error).toMatchObject({ code: -32602, message: 'params.id required' })
  })

  it('GetTask 支持 historyLength，未知任务报 -32001', async () => {
    const harness = await start(instant())
    const sent = await call(harness.url, rpc('SendMessage', message('a')))
    const id = (sent.body.result as { task: { id: string } }).task.id
    const full = await call(harness.url, rpc('GetTask', { id }))
    expect((full.body.result as { history: unknown[] }).history).toHaveLength(1)
    const sliced = await call(harness.url, rpc('GetTask', { id, historyLength: 0 }))
    expect('history' in (sliced.body.result as object)).toBe(false)
    const missing = await call(harness.url, rpc('GetTask', { id: 'nope' }))
    expect(missing.body.error).toMatchObject({ code: -32001 })
  })

  it('ListTasks 按会话与状态筛选、游标分页，默认省略工件', async () => {
    const harness = await start(instant())
    await call(harness.url, rpc('SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'a' }], contextId: 'ctx' } }))
    await call(harness.url, rpc('SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'b' }], contextId: 'ctx' } }))
    await call(harness.url, rpc('SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'c' }], contextId: 'other' } }))
    const all = await call(harness.url, rpc('ListTasks', { contextId: 'ctx', includeArtifacts: true }))
    const page = all.body.result as {
      tasks: { id: string; artifacts: unknown[] }[]
      totalSize: number
      pageSize: number
      nextPageToken: string
    }
    expect(page.totalSize).toBe(2)
    expect(page.pageSize).toBe(2)
    expect(page.nextPageToken).toBe('')
    expect(page.tasks[0]?.artifacts).toHaveLength(1)
    const omitted = await call(harness.url, rpc('ListTasks', { contextId: 'ctx' }))
    expect('artifacts' in ((omitted.body.result as { tasks: unknown[] }).tasks[0] as object)).toBe(false)
    const firstPage = await call(harness.url, rpc('ListTasks', { contextId: 'ctx', pageSize: 1 }))
    const token = (firstPage.body.result as { nextPageToken: string }).nextPageToken
    expect(token.length).toBeGreaterThan(0)
    expect((firstPage.body.result as { tasks: unknown[] }).tasks).toHaveLength(1)
    const secondPage = await call(harness.url, rpc('ListTasks', { contextId: 'ctx', pageSize: 1, pageToken: token }))
    const second = (secondPage.body.result as { tasks: { id: string }[]; nextPageToken: string })
    expect(second.tasks).toHaveLength(1)
    expect(second.nextPageToken).toBe('')
    expect(second.tasks[0]?.id).not.toBe((firstPage.body.result as { tasks: { id: string }[] }).tasks[0]?.id)
    const staleToken = Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00.000Z', i: 'ghost' }), 'utf8').toString('base64url')
    const stale = await call(harness.url, rpc('ListTasks', { contextId: 'ctx', pageSize: 1, pageToken: staleToken }))
    expect((stale.body.result as { tasks: unknown[]; nextPageToken: string }).tasks).toEqual([])
    const bad = await call(harness.url, rpc('ListTasks', { contextId: 'ctx', pageToken: 'not-a-cursor' }))
    expect(bad.body.error).toMatchObject({ code: -32602 })
    const byStatus = await call(harness.url, rpc('ListTasks', { status: 'TASK_STATE_SUBMITTED' }))
    expect((byStatus.body.result as { tasks: unknown[] }).tasks).toEqual([])
    const clamped = await call(harness.url, rpc('ListTasks', { pageSize: 9999 }))
    expect((clamped.body.result as { tasks: unknown[] }).tasks.length).toBeLessThanOrEqual(100)
  })

  it('排序按状态时间戳降序：新状态的任务排到最前', async () => {
    const harness = await start(instant())
    const first = await call(harness.url, rpc('SendMessage', message('a')))
    const second = await call(harness.url, rpc('SendMessage', message('b')))
    const firstId = (first.body.result as { task: { id: string } }).task.id
    const secondId = (second.body.result as { task: { id: string } }).task.id
    // 把第一个任务的状态时间戳拨到最旧，它就该沉底。
    harness.server.store.get(firstId)!.status.timestamp = '2020-01-01T00:00:00.000Z'
    const listed = await call(harness.url, rpc('ListTasks'))
    expect((listed.body.result as { tasks: { id: string }[] }).tasks.map(task => task.id)).toEqual([secondId, firstId])
  })

  it('缺失或不支持的 A2A-Version 回 -32009，patch 号忽略', async () => {
    const harness = await start(instant())
    // 空值按规范视为 0.3，因此同样被拒绝。
    const empty = await fetch(harness.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '' },
      body: JSON.stringify(rpc('SendMessage', message('a'))),
    })
    expect((await empty.json() as { error: { code: number } }).error.code).toBe(-32009)
    for (const version of ['0.3', '2.0', '1']) {
      const reply = await call(harness.url, rpc('SendMessage', message('a')), { version })
      expect(reply.body.error).toMatchObject({ code: -32009 })
      expect((reply.body.error as { data: { reason: string }[] }).data[0]).toMatchObject({ reason: 'FAILED_PRECONDITION' })
    }
    const patched = await call(harness.url, rpc('SendMessage', message('a')), { version: '1.0.1' })
    expect(patched.body.result).toBeDefined()
    const query = await fetch(`${harness.url}?A2A-Version=0.3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpc('SendMessage', message('a'))),
    })
    expect((await query.json() as { error: { code: number } }).error.code).toBe(-32009)
  })

  it('CancelTask 把运行中的任务置为 CANCELED 并通知执行器，终态后再取消回 -32002', async () => {
    let finish = (): void => {}
    const onCancel = vi.fn((_context: { readonly taskId: string; readonly contextId: string }) => {})
    const harness = await start({
      onMessage: async (ctx) => {
        ctx.sink.sendStatus('TASK_STATE_WORKING')
        await Promise.race([
          new Promise<void>((resolve) => { finish = resolve }),
          new Promise<void>((resolve) => { setTimeout(resolve, 1000).unref() }),
        ])
      },
      onCancel,
    })
    try {
      const sent = await call(harness.url, rpc('SendMessage', { ...message('a'), configuration: { returnImmediately: true } }))
      const id = (sent.body.result as { task: { id: string } }).task.id
      const canceled = await call(harness.url, rpc('CancelTask', { id }))
      expect((canceled.body.result as { status: { state: string } }).status.state).toBe('TASK_STATE_CANCELED')
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onCancel.mock.calls[0]?.[0].taskId).toBe(id)
      expect(typeof onCancel.mock.calls[0]?.[0].contextId).toBe('string')
      const again = await call(harness.url, rpc('CancelTask', { id }))
      expect(again.body.error).toMatchObject({ code: -32002 })
      expect((again.body.error as { data: { reason: string }[] }).data[0]).toMatchObject({ reason: 'TASK_NOT_CANCELABLE' })
      expect(onCancel).toHaveBeenCalledTimes(1)
    } finally {
      finish()
    }
  })

  it('GetExtendedAgentCard 未声明能力时回 -32004', async () => {
    const harness = await start(instant())
    const refused = await call(harness.url, rpc('GetExtendedAgentCard'))
    expect(refused.body.error).toMatchObject({ code: -32004 })
    expect((refused.body.error as { data: { reason: string }[] }).data[0]).toMatchObject({ reason: 'UNSUPPORTED_OPERATION' })
  })

  it('GetExtendedAgentCard 声明能力后返回卡片', async () => {
    const card: AgentCard = {
      ...CARD,
      capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: true },
    }
    const harness = await start(instant(), { card })
    const reply = await call(harness.url, rpc('GetExtendedAgentCard'))
    expect((reply.body.result as AgentCard).name).toBe('test-agent')
  })

  it('响应写入失败时报给 onError', async () => {
    const onError = vi.fn()
    const handler = createA2ARequestHandler({ card: CARD, executor: instant(), onError })
    let wrote = 0
    const res = {
      headersSent: false,
      writeHead() {
        wrote += 1
        if (wrote === 1) throw new Error('socket gone')
        return this
      },
      end() {},
    }
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/', headers: {} })
    handler(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse)
    req.emit('end')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(onError).toHaveBeenCalledWith('handling an A2A request failed', expect.any(Error))
  })
})

describe('teeSink', () => {
  it('把状态与工件转发给每个 sink', () => {
    const a: string[] = []
    const b: string[] = []
    const sinkOf = (log: string[]) => ({
      sendStatus: (state: string, text?: string) => { log.push(`status:${state}:${text ?? ''}`) },
      appendArtifact: (artifactId: string, name: string, text: string, lastChunk?: boolean) => {
        log.push(`artifact:${artifactId}:${name}:${text}:${String(lastChunk ?? false)}`)
      },
    })
    const tee = teeSink(sinkOf(a), sinkOf(b))
    tee.sendStatus('TASK_STATE_WORKING', '进行中')
    tee.appendArtifact('reply', 'reply', 'x', true)
    expect(a).toEqual(['status:TASK_STATE_WORKING:进行中', 'artifact:reply:reply:x:true'])
    expect(b).toEqual(a)
  })
})

describe('A2A 推送通知配置', () => {
  it('内联配置在首个事件前注册，并把事件投递到 webhook', async () => {
    const hook = await webhook()
    const harness = await start(instant(), { card: PUSH_CARD })
    const sent = await call(harness.url, rpc('SendMessage', {
      ...message('你好'),
      configuration: { taskPushNotificationConfig: { url: hook.url, token: 'tok' } },
    }))
    const id = taskIdOf(sent)
    await waitFor(() => hook.deliveries.length >= 3)
    expect(hook.deliveries[0]?.body).toMatchObject({ task: { id } })
    expect(hook.deliveries.at(-1)?.body).toMatchObject({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } })
    expect(hook.deliveries[0]?.headers['content-type']).toBe('application/a2a+json')
    expect(hook.deliveries[0]?.headers['x-a2a-notification-token']).toBe('tok')
    const listed = await call(harness.url, rpc('ListTaskPushNotificationConfigs', { taskId: id }))
    const configs = (listed.body.result as { configs: TaskPushNotificationConfig[] }).configs
    expect(configs).toHaveLength(1)
    const config = configs[0]!
    const got = await call(harness.url, rpc('GetTaskPushNotificationConfig', { taskId: id, id: config.id }))
    expect((got.body.result as TaskPushNotificationConfig).url).toBe(hook.url)
    const deleted = await call(harness.url, rpc('DeleteTaskPushNotificationConfig', { taskId: id, id: config.id }))
    expect(deleted.body.result).toEqual({})
  })

  it('配置分页读取，页大小与游标都有默认值', async () => {
    const hook = await webhook()
    const harness = await start(instant(), { card: PUSH_CARD })
    const id = taskIdOf(await call(harness.url, rpc('SendMessage', message('a'))))
    for (const configId of ['c1', 'c2', 'c3']) {
      await call(harness.url, rpc('CreateTaskPushNotificationConfig', { taskId: id, url: hook.url, id: configId }))
    }
    const ignoredPageSize = await call(harness.url, rpc('ListTaskPushNotificationConfigs', { taskId: id, pageSize: 'many' }))
    expect((ignoredPageSize.body.result as { configs: unknown[] }).configs).toHaveLength(3)
    const first = await call(harness.url, rpc('ListTaskPushNotificationConfigs', { taskId: id, pageSize: 2 }))
    expect((first.body.result as { configs: unknown[] }).configs).toHaveLength(2)
    const token = (first.body.result as { nextPageToken: string }).nextPageToken
    expect(token).not.toBe('')
    const rest = await call(harness.url, rpc('ListTaskPushNotificationConfigs', { taskId: id, pageSize: 2, pageToken: token }))
    expect((rest.body.result as { configs: unknown[] }).configs).toHaveLength(1)
    expect((rest.body.result as { nextPageToken: string }).nextPageToken).toBe('')
    const unreadable = await call(harness.url, rpc('ListTaskPushNotificationConfigs', { taskId: id, pageSize: 1, pageToken: '!!' }))
    expect((unreadable.body.result as { configs: unknown[] }).configs).toHaveLength(1)
  })

  it('配置参数的缺失与未知对象分别回 -32602 与 -32001', async () => {
    const hook = await webhook()
    const harness = await start(instant(), { card: PUSH_CARD })
    const id = taskIdOf(await call(harness.url, rpc('SendMessage', message('a'))))
    const noTaskId = await call(harness.url, rpc('CreateTaskPushNotificationConfig', { url: hook.url }))
    expect(noTaskId.body.error).toMatchObject({ code: -32602 })
    const unknownTask = await call(harness.url, rpc('CreateTaskPushNotificationConfig', { taskId: 'ghost', url: hook.url }))
    expect(unknownTask.body.error).toMatchObject({ code: -32001 })
    const noUrl = await call(harness.url, rpc('CreateTaskPushNotificationConfig', { taskId: id }))
    expect(noUrl.body.error).toMatchObject({ code: -32602 })
    const missingId = await call(harness.url, rpc('GetTaskPushNotificationConfig', { taskId: id }))
    expect(missingId.body.error).toMatchObject({ code: -32602 })
    const unknownConfig = await call(harness.url, rpc('GetTaskPushNotificationConfig', { taskId: id, id: 'ghost' }))
    expect(unknownConfig.body.error).toMatchObject({ code: -32001 })
    const missingDeleteParam = await call(harness.url, rpc('DeleteTaskPushNotificationConfig', { taskId: id }))
    expect(missingDeleteParam.body.error).toMatchObject({ code: -32602 })
    const unknownDelete = await call(harness.url, rpc('DeleteTaskPushNotificationConfig', { taskId: id, id: 'ghost' }))
    expect(unknownDelete.body.error).toMatchObject({ code: -32001 })
  })

  it('声明的认证方案与凭据写进投递头', async () => {
    const hook = await webhook()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const harness = await start({
      onMessage: async (ctx) => {
        await gate
        ctx.sink.appendArtifact('reply', 'reply', 'done', true)
      },
    }, { card: PUSH_CARD })
    const sent = await call(harness.url, rpc('SendMessage', {
      ...message('a'),
      configuration: { returnImmediately: true },
    }))
    const id = taskIdOf(sent)
    await call(harness.url, rpc('CreateTaskPushNotificationConfig', {
      taskId: id,
      url: hook.url,
      id: 'with-credentials',
      authentication: { scheme: 'Bearer', credentials: 'secret' },
    }))
    await call(harness.url, rpc('CreateTaskPushNotificationConfig', {
      taskId: id,
      url: hook.url,
      id: 'scheme-only',
      authentication: { scheme: 'Basic' },
    }))
    release()
    await waitFor(() => hook.deliveries.length >= 2)
    const authorization = hook.deliveries.map(delivery => delivery.headers.authorization)
    expect(authorization).toContain('Bearer secret')
    expect(authorization).toContain('Basic')
  })

  it('5xx 重试一次后成功，4xx 不重试并报给 onError', async () => {
    const retried = await webhook()
    retried.failures = 1
    const quiet = vi.fn()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const harness = await start({
      onMessage: async (ctx) => {
        ctx.sink.sendStatus('TASK_STATE_WORKING')
        await gate
        ctx.sink.appendArtifact('reply', 'reply', 'done', true)
      },
    }, { card: PUSH_CARD, onError: quiet })
    await call(harness.url, rpc('SendMessage', {
      ...message('a'),
      configuration: { returnImmediately: true, taskPushNotificationConfig: { url: retried.url } },
    }))
    await waitFor(() => retried.deliveries.length >= 2)
    expect(quiet).not.toHaveBeenCalled()
    release()

    const refused = await webhook()
    refused.status = 404
    const reported = vi.fn()
    const failing = await start(instant(), { card: PUSH_CARD, onError: reported })
    await call(failing.url, rpc('SendMessage', {
      ...message('b'),
      configuration: { taskPushNotificationConfig: { url: refused.url } },
    }))
    await waitFor(() => reported.mock.calls.length >= 1)
    expect(reported).toHaveBeenCalledWith('A2A push delivery failed', expect.any(Error))
    expect(refused.deliveries).toHaveLength(3)
  })

  it('未声明推送能力时内联配置与四个方法都被拒绝', async () => {
    const hook = await webhook()
    const harness = await start(instant())
    const sent = await call(harness.url, rpc('SendMessage', {
      ...message('a'),
      configuration: { taskPushNotificationConfig: { url: hook.url } },
    }))
    expect(sent.body.error).toMatchObject({ code: -32003 })
    for (const method of [
      'CreateTaskPushNotificationConfig',
      'GetTaskPushNotificationConfig',
      'ListTaskPushNotificationConfigs',
      'DeleteTaskPushNotificationConfig',
    ]) {
      const refused = await call(harness.url, rpc(method, { taskId: 't', id: 'c', url: hook.url }))
      expect(refused.body.error).toMatchObject({ code: -32003 })
    }
    expect(hook.deliveries).toEqual([])
  })

  it('任务淘汰时连带丢弃它的推送配置', async () => {
    const hook = await webhook()
    const store = new TaskStore({ maxTasks: 2 })
    const harness = await start(instant(), { card: PUSH_CARD, store })
    const id = taskIdOf(await call(harness.url, rpc('SendMessage', message('a'))))
    await call(harness.url, rpc('CreateTaskPushNotificationConfig', { taskId: id, url: hook.url, id: 'cfg' }))
    await call(harness.url, rpc('SendMessage', message('b')))
    await call(harness.url, rpc('SendMessage', message('c')))
    expect(store.get(id)).toBeUndefined()
    const readded = store.ensureTask(id, 'ctx-again')
    expect(readded.id).toBe(id)
    const listed = await call(harness.url, rpc('ListTaskPushNotificationConfigs', { taskId: id }))
    expect((listed.body.result as { configs: unknown[] }).configs).toEqual([])
  })
})

describe('A2A 请求解析边界', () => {
  it('接受 ROLE_AGENT、historyLength、tenant 与残缺的 authentication', async () => {
    const hook = await webhook()
    const harness = await start(instant(), { card: PUSH_CARD })
    const sent = await call(harness.url, rpc('SendMessage', {
      message: { messageId: 'm1', role: 'ROLE_AGENT', parts: [{ text: '你好' }] },
      configuration: {
        historyLength: 1,
        taskPushNotificationConfig: {
          url: hook.url,
          id: 'cfg',
          tenant: 'tenant-a',
          authentication: { scheme: '' },
        },
      },
    }))
    const id = taskIdOf(sent)
    await call(harness.url, rpc('CreateTaskPushNotificationConfig', {
      taskId: id,
      url: hook.url,
      id: 'plain',
      authentication: 'not-an-object',
    }))
    const listed = await call(harness.url, rpc('ListTaskPushNotificationConfigs', { taskId: id }))
    const configs = (listed.body.result as { configs: TaskPushNotificationConfig[] }).configs
    expect(configs.map(config => config.id).sort()).toEqual(['cfg', 'plain'])
    const inline = configs.find(config => config.id === 'cfg')
    expect(inline).toMatchObject({ tenant: 'tenant-a' })
    expect(inline?.authentication).toBeUndefined()
    expect(configs.find(config => config.id === 'plain')?.authentication).toBeUndefined()
    const message = (await call(harness.url, rpc('GetTask', { id, historyLength: 1 }))).body.result as { history: unknown[] }
    expect(message.history).toHaveLength(1)
  })

  it('删掉同一任务的一个配置后其余配置仍在', async () => {
    const hook = await webhook()
    const harness = await start(instant(), { card: PUSH_CARD })
    const id = taskIdOf(await call(harness.url, rpc('SendMessage', message('a'))))
    await call(harness.url, rpc('CreateTaskPushNotificationConfig', { taskId: id, url: hook.url, id: 'keep' }))
    await call(harness.url, rpc('CreateTaskPushNotificationConfig', { taskId: id, url: hook.url, id: 'drop' }))
    await call(harness.url, rpc('DeleteTaskPushNotificationConfig', { taskId: id, id: 'drop' }))
    const listed = await call(harness.url, rpc('ListTaskPushNotificationConfigs', { taskId: id }))
    expect((listed.body.result as { configs: { id: string }[] }).configs.map(config => config.id)).toEqual(['keep'])
  })

  it('无效的任务超时配置在构造时拒绝', () => {
    expect(() => createA2AServer({ card: CARD, executor: instant(), port: 0, taskTimeoutMs: 0 })).toThrow(/taskTimeoutMs/)
  })

  it('非回环绑定缺少 apiKey 时拒绝启动', () => {
    expect(() => createA2AServer({ card: CARD, executor: instant(), port: 0, host: '0.0.0.0' })).toThrow(/requires a non-empty apiKey/)
  })

  it('默认主机与空 apiKey 用于回环监听，关闭两次时第二次报错', async () => {
    const server = createA2AServer({ card: CARD, executor: instant(), port: 0 })
    await server.ready
    await server.close()
    await expect(server.close()).rejects.toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' })
  })

  it('端口已被占用时 ready 拒绝', async () => {
    const first = await start(instant())
    const port = (first.server.server.address() as { port: number }).port
    const second = createA2AServer({ card: CARD, executor: instant(), port })
    await expect(second.ready).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('非法请求体按子句分别报 -32600', async () => {
    const harness = await start(instant())
    const post = async (body: string): Promise<Record<string, unknown>> => {
      const response = await fetch(harness.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
        body,
      })
      return await response.json() as Record<string, unknown>
    }
    expect((await post(JSON.stringify({ jsonrpc: '2.0' }))).id).toBeNull()
    expect((await post(JSON.stringify({ jsonrpc: '2.0', id: 'keep', method: 7 }))).id).toBe('keep')
    expect((await post(JSON.stringify([1, 2]))).id).toBeNull()
    expect((await post(JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'GetTask', params: { id: 'ghost' } }))).error)
      .toMatchObject({ code: -32001 })
  })

  it('ListTasks 拒绝不是游标的 pageToken', async () => {
    const harness = await start(instant())
    const invalid = await call(harness.url, rpc('ListTasks', { pageToken: 'not-a-cursor' }))
    expect(invalid.body.error).toMatchObject({ code: -32602 })
  })

  it('协议版本可来自重复表头或查询参数，patch 号被忽略', async () => {
    const harness = await start(instant())
    const post = async (headers: Record<string, string>, url = harness.url): Promise<Record<string, unknown>> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(rpc('ListTasks', {})),
      })
      return await response.json() as Record<string, unknown>
    }
    expect((await post({ 'A2A-Version': '1.0.7' })).result).toBeDefined()
    expect((await post({ 'A2A-Version': '1.0' })).result).toBeDefined()
    const query = await post({}, `${harness.url}?A2A-Version=1.0.3`)
    expect(query.result).toBeDefined()
  })
})

describe('A2A 总线入口与执行驱动', () => {
  it('attachTask 建任务并执行一轮，重复与终态调用都复用同一结果', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const seen: string[] = []
    const harness = await start({
      onMessage: async (ctx) => {
        seen.push(ctx.taskId)
        await gate
        ctx.sink.appendArtifact('reply', 'reply', `bus:${ctx.text}`, true)
      },
    })
    const session = harness.server.attachTask({ taskId: 'b1', contextId: 'c1' })
    const context = { taskId: 'b1', contextId: 'c1', skill: 'default', text: '你好', metadata: {} }
    const first = harness.server.executeTask(context, session)
    const second = harness.server.executeTask(context)
    release()
    const [finished, reused] = await Promise.all([first, second])
    expect(finished.id).toBe('b1')
    expect(reused.id).toBe('b1')
    expect(seen).toEqual(['b1'])
    expect(finished.status.state).toBe('TASK_STATE_COMPLETED')
    const again = await harness.server.executeTask({ ...context, text: '再来' })
    expect(again.artifacts[0]?.parts).toEqual([{ text: 'bus:你好' }])
    expect(seen).toEqual(['b1'])
  })

  it('执行会话收尾后的写入被丢弃', async () => {
    let captured: Parameters<Parameters<typeof start>[0]['onMessage']>[0] | undefined
    const harness = await start({
      onMessage: (ctx) => {
        captured = ctx
        ctx.sink.appendArtifact('reply', 'reply', 'ok', true)
        return Promise.resolve()
      },
    })
    await call(harness.url, rpc('SendMessage', message('a')))
    // 任务已经完成，执行器事后再写状态与工件都不应改变结果
    captured?.sink.sendStatus('TASK_STATE_WORKING', '迟到')
    captured?.sink.appendArtifact('reply', 'reply', '迟到')
    const stored = harness.server.store.all()[0]
    expect(stored?.status.state).toBe('TASK_STATE_COMPLETED')
    expect(stored?.artifacts[0]?.parts).toEqual([{ text: 'ok' }])
  })

  it('取消后执行器的写入被丢弃，取消钩子只调用一次', async () => {
    let captured: Parameters<Parameters<typeof start>[0]['onMessage']>[0] | undefined
    const onCancel = vi.fn()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const harness = await start({
      onMessage: async (ctx) => {
        captured = ctx
        await gate
      },
      onCancel,
    })
    const sent = await call(harness.url, rpc('SendMessage', {
      ...message('a'),
      configuration: { returnImmediately: true },
    }))
    const id = taskIdOf(sent)
    const canceled = await call(harness.url, rpc('CancelTask', { id }))
    expect((canceled.body.result as { status: { state: string } }).status.state).toBe('TASK_STATE_CANCELED')
    expect(onCancel).toHaveBeenCalledTimes(1)
    captured?.sink.sendStatus('TASK_STATE_WORKING', '迟到')
    captured?.sink.appendArtifact('reply', 'reply', '迟到')
    release()
    await waitFor(() => harness.server.store.get(id)?.status.state === 'TASK_STATE_CANCELED')
    expect(harness.server.store.get(id)?.artifacts).toEqual([])
  })

  it('取消之后超时再触发取消时不重复上报', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const onCancel = vi.fn()
    const harness = await start({
      onMessage: async () => { await gate },
      onCancel,
    }, { taskTimeoutMs: 20 })
    const sent = await call(harness.url, rpc('SendMessage', {
      ...message('a'),
      configuration: { returnImmediately: true },
    }))
    const id = taskIdOf(sent)
    await call(harness.url, rpc('CancelTask', { id }))
    await new Promise(resolve => setTimeout(resolve, 40))
    release()
    await waitFor(() => harness.server.store.get(id)?.status.state === 'TASK_STATE_CANCELED')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('没有订阅者的任务被取消时照常广播', async () => {
    const harness = await start(instant())
    harness.server.store.ensureTask('orphan', 'ctx-orphan')
    const canceled = await call(harness.url, rpc('CancelTask', { id: 'orphan' }))
    expect((canceled.body.result as { status: { state: string } }).status.state).toBe('TASK_STATE_CANCELED')
  })

  it('投递失败由 onError 上报，上报自身抛错也不中断投递链', async () => {
    const harness = await start(instant(), {
      card: PUSH_CARD,
      onError: () => { throw new Error('reporter failed') },
    })
    await call(harness.url, rpc('SendMessage', {
      ...message('a'),
      configuration: { taskPushNotificationConfig: { url: 'http://127.0.0.1:1/unreachable' } },
    }))
    const healthy = await call(harness.url, rpc('SendMessage', message('b')))
    expect(taskIdOf(healthy)).toBeTruthy()
    expect(harness.server.store.all()).toHaveLength(2)
  })
})

describe('A2A 事件流生命周期', () => {
  it('客户端断开后不再写帧，任务照常结束', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const harness = await start({
      onMessage: async (ctx) => {
        ctx.sink.sendStatus('TASK_STATE_WORKING')
        await gate
        ctx.sink.appendArtifact('reply', 'reply', 'late', true)
      },
    })
    const id = taskIdOf(await call(harness.url, rpc('SendMessage', {
      ...message('a'),
      configuration: { returnImmediately: true },
    })))
    const controller = new AbortController()
    const response = await fetch(harness.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify(rpc('SubscribeToTask', { id })),
      signal: controller.signal,
    })
    const reader = response.body?.getReader()
    await reader?.read()
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    await waitFor(() => harness.server.store.get(id)?.status.state === 'TASK_STATE_COMPLETED')
    await new Promise(resolve => setTimeout(resolve, 20))
  })
})

describe('A2A 会话收尾与超时', () => {
  it('会话收尾后 sink 不再写库', async () => {
    const harness = await start(instant())
    const session = harness.server.attachTask({ taskId: 's1', contextId: 'c1' })
    session.sink.sendStatus('TASK_STATE_WORKING', '进行中')
    const finished = session.finish()
    session.sink.sendStatus('TASK_STATE_WORKING', '迟到')
    session.sink.appendArtifact('reply', 'reply', '迟到')
    expect(finished.status.state).toBe('TASK_STATE_COMPLETED')
    expect(harness.server.store.get('s1')?.artifacts).toEqual([])
  })

  it('不带会话的执行自己建会话', async () => {
    const harness = await start(instant())
    const finished = await harness.server.executeTask({
      taskId: 'direct',
      contextId: 'c-direct',
      skill: 'default',
      text: '你好',
      metadata: {},
    })
    expect(finished.status.state).toBe('TASK_STATE_COMPLETED')
    expect(finished.artifacts[0]?.parts).toEqual([{ text: 'ok' }])
  })

  it('取消钩子抛错时上报 onError', async () => {
    const onError = vi.fn()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const harness = await start({
      onMessage: async () => { await gate },
      onCancel: () => { throw new Error('hook failed') },
    }, { onError })
    const id = taskIdOf(await call(harness.url, rpc('SendMessage', {
      ...message('a'),
      configuration: { returnImmediately: true },
    })))
    await call(harness.url, rpc('CancelTask', { id }))
    await waitFor(() => onError.mock.calls.length >= 1)
    expect(onError).toHaveBeenCalledWith('A2A onCancel failed', expect.any(Error))
    release()
  })

  it('超出任务期限时置 FAILED 并在状态消息里写明原因', async () => {
    const harness = await start({
      onMessage: async () => { await new Promise<void>(() => {}) },
    }, { taskTimeoutMs: 20 })
    const id = taskIdOf(await call(harness.url, rpc('SendMessage', {
      ...message('a'),
      configuration: { returnImmediately: true },
    })))
    await waitFor(() => harness.server.store.get(id)?.status.state === 'TASK_STATE_FAILED')
    expect(harness.server.store.get(id)?.status.message?.parts).toEqual([{ text: 'task timed out after 20ms' }])
  })

  it('空的查询版本与非法游标载荷都按协议拒绝', async () => {
    const harness = await start(instant())
    const empty = await fetch(`${harness.url}?A2A-Version=`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpc('ListTasks', {})),
    })
    expect(((await empty.json()) as { error: { code: number } }).error.code).toBe(-32009)
    const token = Buffer.from('{"t":1}').toString('base64url')
    const invalid = await call(harness.url, rpc('ListTasks', { pageToken: token }))
    expect(invalid.body.error).toMatchObject({ code: -32602 })
  })

  it('投递失败且没有配置 onError 时只记在默认空处理器上', async () => {
    const hook = await webhook()
    hook.status = 404
    const harness = await start(instant(), { card: PUSH_CARD })
    await call(harness.url, rpc('SendMessage', {
      ...message('a'),
      configuration: { taskPushNotificationConfig: { url: hook.url } },
    }))
    await waitFor(() => hook.deliveries.length >= 3)
  })
})
