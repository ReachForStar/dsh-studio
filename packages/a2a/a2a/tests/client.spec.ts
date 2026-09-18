import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { A2AClient } from '../src/client.ts'
import { createA2AServer, type A2AExecutor } from '../src/server.ts'
import type { A2AStreamEvent, AgentCard } from '../src/schema.ts'

const CARD: AgentCard = {
  name: 'peer',
  description: 'peer',
  version: '1.0.0',
  supportedInterfaces: [{ url: 'http://127.0.0.1:0/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'default', name: 's', description: 'd', tags: [] }],
}

const cleanup: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

/** 起一个只回固定响应的 HTTP 服务，用来构造协议异常分支。 */
async function rawServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
}

async function peerServer(executor: A2AExecutor): Promise<{ url: string; server: ReturnType<typeof createA2AServer> }> {
  const server = createA2AServer({ card: CARD, executor, port: 0 })
  await server.ready
  cleanup.push(() => server.close())
  return { url: `http://127.0.0.1:${String((server.server.address() as AddressInfo).port)}/`, server }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not reached in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const echo: A2AExecutor = {
  onMessage: async (ctx) => {
    ctx.sink.appendArtifact('reply', 'reply', `echo:${ctx.text}`, true)
  },
}

describe('A2AClient 基本调用', () => {
  it('读取卡片、发送消息并取回任务工件', async () => {
    const client = new A2AClient({ url: (await peerServer(echo)).url })
    expect((await client.getCard()).name).toBe('peer')
    const task = await client.sendMessage({ text: 'hi' })
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.artifacts[0]?.parts).toEqual([{ text: 'echo:hi' }])
    const reread = await client.getTask(task.id)
    expect(reread.id).toBe(task.id)
    const listed = await client.listTasks({ contextId: task.contextId })
    expect(listed.totalSize).toBe(1)
    expect(listed.tasks).toHaveLength(1)
    await expect(client.cancelTask(task.id)).rejects.toThrow(/code -32002/)
  })

  it('支持自定义卡片路径并把非 2xx 报成错误', async () => {
    const url = await rawServer((_req, res) => {
      res.writeHead(404)
      res.end('nope')
    })
    const client = new A2AClient({ url })
    await expect(client.getCard({ path: '/custom.json' })).rejects.toThrow(/agent card request failed with HTTP 404/)
  })

  it('把 apiKey 作为 X-Api-Key 发出，带上 A2A-Version 头，并支持自定义卡片路径', async () => {
    const seen: string[] = []
    const url = await rawServer((req, res) => {
      seen.push(`${req.url ?? ''} ${String(req.headers['x-api-key'] ?? '')} ${String(req.headers['a2a-version'] ?? '')}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(req.url === '/card.json'
        ? JSON.stringify(CARD)
        : JSON.stringify({ jsonrpc: '2.0', id: '1', result: { task: { id: 't', contextId: 'c', status: { state: 'TASK_STATE_COMPLETED', timestamp: 'now' }, artifacts: [], history: [] } } }))
    })
    const client = new A2AClient({ url, apiKey: 'secret' })
    expect((await client.getCard({ path: '/card.json' })).name).toBe('peer')
    await client.sendMessage({ text: 'hi' })
    expect(seen[0]?.startsWith('/card.json')).toBe(true)
    expect(seen[1]).toBe('/ secret 1.0')
  })

  it('对端只回 message 时报错而不是当成空任务', async () => {
    const url = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { message: { messageId: 'm', role: 'ROLE_AGENT', parts: [] } } }))
    })
    const client = new A2AClient({ url })
    await expect(client.sendMessage({ text: 'hi' })).rejects.toThrow(/message-mode answers are not supported/)
  })

  it('把 JSON-RPC 错误转成异常', async () => {
    const url = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32001, message: 'Task not found: x' } }))
    })
    const client = new A2AClient({ url })
    await expect(client.getTask('x')).rejects.toThrow(/A2A GetTask failed with code -32001: Task not found: x/)
  })

  it('调用方的取消信号会中断等待', async () => {
    const url = (await peerServer({
      onMessage: async (ctx) => {
        await new Promise(resolve => setTimeout(resolve, 300))
        ctx.sink.appendArtifact('reply', 'reply', 'late', true)
      },
    })).url
    const client = new A2AClient({ url })
    const controller = new AbortController()
    const pending = client.sendMessage({ text: 'hi' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it('超时预算会中断等待', async () => {
    const url = (await peerServer({
      onMessage: async (ctx) => {
        await new Promise(resolve => setTimeout(resolve, 200))
        ctx.sink.appendArtifact('reply', 'reply', 'late', true)
      },
    })).url
    const client = new A2AClient({ url, timeoutMs: 20 })
    await expect(client.sendMessage({ text: 'hi' })).rejects.toThrow()
  })
})

describe('A2AClient 流式调用', () => {
  it('逐帧产出任务、状态、工件与终态', async () => {
    const client = new A2AClient({
      url: (await peerServer({
        onMessage: async (ctx) => {
          ctx.sink.sendStatus('TASK_STATE_WORKING')
          ctx.sink.appendArtifact('reply', 'reply', 'a')
          ctx.sink.appendArtifact('reply', 'reply', 'b', true)
        },
      })).url,
    })
    const frames: A2AStreamEvent[] = []
    for await (const event of client.sendMessageStream({ text: 'hi' })) frames.push(event)
    expect(frames.map(frame => Object.keys(frame)[0])).toEqual([
      'task', 'statusUpdate', 'artifactUpdate', 'artifactUpdate', 'statusUpdate',
    ])
    expect(frames.at(-1)).toMatchObject({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } })
  })

  it('把流内的错误帧转成异常', async () => {
    const client = new A2AClient({
      url: await rawServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32001, message: 'Task not found: x' } }))
      }),
    })
    const frames: A2AStreamEvent[] = []
    await expect((async () => {
      for await (const event of client.sendMessageStream({ text: 'hi' })) frames.push(event)
    })()).rejects.toThrow(/SendStreamingMessage failed with code -32001/)
    expect(frames).toEqual([])
  })

  it('响应头缺失时把状态码写进错误', async () => {
    const client = new A2AClient({
      url: await rawServer((_req, res) => {
        res.writeHead(503)
        res.end('busy')
      }),
    })
    await expect((async () => {
      for await (const event of client.sendMessageStream({ text: 'hi' })) void event
    })()).rejects.toThrow(/SendStreamingMessage failed with HTTP 503: busy/)
  })

  it('首帧之前的瞬态断连重试一次', async () => {
    let attempts = 0
    const url = await rawServer((req, res) => {
      attempts += 1
      if (attempts === 1) {
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'ok' }] } })}\n\n`)
      res.end()
    })
    const client = new A2AClient({ url })
    const frames: A2AStreamEvent[] = []
    for await (const event of client.sendMessageStream({ text: 'hi' })) frames.push(event)
    expect(attempts).toBe(2)
    expect(frames).toHaveLength(1)
  })

  it('已经收到帧之后不再重试', async () => {
    let attempts = 0
    const url = await rawServer((_req, res) => {
      attempts += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ task: { id: 't', contextId: 'c', status: { state: 'TASK_STATE_WORKING', timestamp: 'now' }, artifacts: [], history: [] } })}\n\n`)
      // 先让客户端确实收到并交出一帧，再断开连接。
      setTimeout(() => { res.socket?.destroy() }, 30)
    })
    const client = new A2AClient({ url })
    await expect((async () => {
      for await (const event of client.sendMessageStream({ text: 'hi' })) void event
    })()).rejects.toThrow()
    expect(attempts).toBe(1)
  })

  it('订阅运行中任务会持续产出事件直到终态', async () => {
    let release: (() => void) | undefined
    const { url, server } = await peerServer({
      onMessage: async (ctx) => {
        ctx.sink.sendStatus('TASK_STATE_WORKING')
        await new Promise<void>((resolve) => { release = resolve })
        ctx.sink.appendArtifact('reply', 'reply', 'late', true)
      },
    })
    const client = new A2AClient({ url })
    const pending = client.sendMessage({ text: 'hi' })
    await waitFor(() => server.store.all().length > 0)
    const task = server.store.all()[0]!
    // 先拿到首帧再放行执行器：首帧证明服务端已过终态校验并挂上订阅，
    // 否则任务可能在订阅请求被处理前就结束。
    const generator = client.subscribeToTask(task.id)
    const firstFrame = await generator.next()
    expect(firstFrame.value).toMatchObject({ task: { id: task.id } })
    release?.()
    const frames: A2AStreamEvent[] = [firstFrame.value as A2AStreamEvent]
    for await (const event of generator) frames.push(event)
    await pending
    expect(frames.map(frame => Object.keys(frame)[0])).toEqual(['task', 'artifactUpdate', 'statusUpdate'])
    expect(frames.at(-1)).toMatchObject({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } })
  })

  it('订阅已终态任务时把 JSON-RPC 错误转成异常', async () => {
    const client = new A2AClient({
      url: (await peerServer({
        onMessage: async (ctx) => {
          ctx.sink.sendStatus('TASK_STATE_WORKING')
          ctx.sink.appendArtifact('reply', 'reply', 'x', true)
        },
      })).url,
    })
    const task = await client.sendMessage({ text: 'hi' })
    await expect((async () => {
      for await (const event of client.subscribeToTask(task.id)) void event
    })()).rejects.toThrow(/SubscribeToTask failed with code -32004/)
  })

  it('订阅失败时把状态码写进错误', async () => {
    const client = new A2AClient({
      url: await rawServer((_req, res) => {
        res.writeHead(500)
        res.end('boom')
      }),
    })
    await expect((async () => {
      for await (const event of client.subscribeToTask('t')) void event
    })()).rejects.toThrow(/SubscribeToTask failed with HTTP 500: boom/)
  })
})
