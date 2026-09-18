import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createA2ARequestHandler, createA2AServer, type A2AExecutor, type A2AServer } from '../src/server.ts'
import type { AgentCard } from '../src/schema.ts'
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

async function start(
  executor: A2AExecutor,
  options: {
    apiKey?: string
    card?: AgentCard
    maxBodyBytes?: number
    store?: TaskStore
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
