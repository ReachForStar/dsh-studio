import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { A2APeerInfo, A2APeerReply, A2ABridgeConfig } from '@reachforstar/dsh-a2a'
import * as tool from '../src/index.ts'

const signal = new AbortController().signal
const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.()
})

interface PeerStub {
  readonly inspect: ReturnType<typeof vi.fn>
  readonly send: ReturnType<typeof vi.fn>
  readonly skills?: ReturnType<typeof vi.fn>
  readonly bridgeConfig?: unknown
  readonly dispatch?: ReturnType<typeof vi.fn>
}

async function setup(stub: PeerStub): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // 桥未配置的桩也要能回答 skills；未配置的 agent 没有 skill。
  ctx.provide('a2a', { skills: () => [], ...stub } as never)
  const fiber = ctx.plugin({ ...tool })
  await fiber.await()
  disposers.push(async () => { await fiber.dispose() })
  return ctx
}

let counter = 0
function call(ctx: Context, name: string, args: unknown): Promise<{ content: { type: string; text?: string }[] }> {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${String(++counter)}`),
    name,
    arguments: args,
  })
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('a2a_peers', () => {
  it('列出可达与不可达的对等端', async () => {
    const rows: A2APeerInfo[] = [
      { name: 'reviewer', url: 'http://reviewer/', title: '审查代理' },
      { name: 'dead', url: 'http://dead/', error: 'connect ECONNREFUSED' },
    ]
    const ctx = await setup({ inspect: vi.fn(() => Promise.resolve(rows)), send: vi.fn() })
    expect(textOf(await call(ctx, 'a2a_peers', {}))).toBe(
      '- reviewer: 审查代理 at http://reviewer/\n- dead: unreachable at http://dead/ (connect ECONNREFUSED)',
    )
  })

  it('没有配置对等端时明确说明', async () => {
    const ctx = await setup({ inspect: vi.fn(() => Promise.resolve([])), send: vi.fn() })
    expect(textOf(await call(ctx, 'a2a_peers', {}))).toBe('No A2A peers are configured for this deployment.')
  })

  it('对等端卡片没有标题时也用名字列出', async () => {
    const ctx = await setup({ inspect: vi.fn(() => Promise.resolve([{ name: 'plain', url: 'http://plain/' }])), send: vi.fn() })
    expect(textOf(await call(ctx, 'a2a_peers', {}))).toBe('- plain: (untitled) at http://plain/')
  })
})

describe('a2a_send', () => {
  it('把消息与续聊标识传给对等端并回答案文本', async () => {
    const send = vi.fn((_request: { peer: string; text: string; contextId?: string; taskId?: string }) => Promise.resolve({
      text: '审查完成',
      taskId: 't-1',
      contextId: 'c-1',
      state: 'TASK_STATE_COMPLETED',
    } satisfies A2APeerReply))
    const ctx = await setup({ inspect: vi.fn(), send })
    const result = await call(ctx, 'a2a_send', { peer: 'reviewer', message: '看看这段代码', contextId: 'c-0', taskId: 't-0' })
    expect(send).toHaveBeenCalledExactlyOnceWith({ peer: 'reviewer', text: '看看这段代码', contextId: 'c-0', taskId: 't-0' })
    expect(textOf(result)).toBe('审查完成')
  })

  it('省略续聊标识时不传这些字段', async () => {
    const send = vi.fn(() => Promise.resolve({ text: 'ok' } satisfies A2APeerReply))
    const ctx = await setup({ inspect: vi.fn(), send })
    await call(ctx, 'a2a_send', { peer: 'http://peer/', message: 'hi' })
    expect(send).toHaveBeenCalledExactlyOnceWith({ peer: 'http://peer/', text: 'hi' })
  })

  it('对等端失败时把失败结果交给调用方', async () => {
    const send = vi.fn(() => Promise.reject(new Error('no A2A peer named "ghost"')))
    const ctx = await setup({ inspect: vi.fn(), send })
    const result = await call(ctx, 'a2a_send', { peer: 'ghost', message: 'hi' }) as unknown as { isError?: boolean; content: { type: string; text?: string }[] }
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no A2A peer named "ghost"')
  })
})

describe('工具注册', () => {
  it('注册两个工具并声明必填参数', async () => {
    const ctx = await setup({ inspect: vi.fn(), send: vi.fn() })
    const peers = ctx.tools.schemas().find(schema => schema.name === 'a2a_peers')
    const send = ctx.tools.schemas().find(schema => schema.name === 'a2a_send')
    expect(peers?.description).toContain('remote A2A agents')
    expect((send?.parameters as { required?: string[] }).required).toEqual(['peer', 'message'])
    expect(tool.name).toBe('tool-a2a')
    expect(tool.inject).toEqual(['tools', 'a2a'])
  })
})

describe('a2a_send 走桥方案', () => {
  const bridge = {
    apiKey: '',
    agents: {
      pi: { port: 9310, defaultWorkspace: '' },
      'claude-code': { port: 9320, defaultWorkspace: '' },
      opencode: { port: 9330, defaultWorkspace: '' },
    },
    skills: { pi: ['code-dev', 'analysis'], 'claude-code': ['code-review', 'coding'], opencode: ['analysis'] },
  } as unknown as A2ABridgeConfig

  /** 桥场景的桩：skills 按桥配置回答，dispatch 记录派发参数。 */
  function bridgeStub(): PeerStub {
    return {
      inspect: vi.fn(async (): Promise<A2APeerInfo[]> => [{ name: 'claude-code', url: 'http://127.0.0.1:9320/' }]),
      send: vi.fn(),
      skills: vi.fn((agent: string) => (bridge.skills as unknown as Record<string, string[]>)[agent] ?? []),
      bridgeConfig: bridge,
      dispatch: vi.fn(async () => ({
        text: '审查结论',
        taskId: 't1',
        contextId: 'c1',
        state: 'TASK_STATE_COMPLETED',
        agent: 'claude-code',
        skill: 'code-review',
        mode: 'direct',
      })),
    }
  }

  it('a2a_peers 带上每个对等端的 skill', async () => {
    const ctx = await setup(bridgeStub())
    expect(textOf(await call(ctx, 'a2a_peers', {}))).toContain('skills: code-review, coding')
  })

  it('按桥 agent 派发时带上 skill 与 workspace，并回传 skill/mode', async () => {
    const stub = bridgeStub()
    const ctx = await setup(stub)
    const result = await call(ctx, 'a2a_send', {
      peer: 'claude-code',
      message: '审查这段 diff',
      skill: 'coding',
      workspace: 'D:/w',
      mode: 'bus',
      wait: true,
      contextId: 'c0',
    })
    expect(result).toBeDefined()
    expect(stub.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'claude-code',
      skill: 'coding',
      text: '审查这段 diff',
      mode: 'bus',
      wait: true,
      workspace: 'D:/w',
      contextId: 'c0',
    }))
    expect(stub.send).not.toHaveBeenCalled()
  })

  it('省略 skill 时用该 agent 的第一个 skill，未配置 skill 的 agent 直接报错', async () => {
    const stub = bridgeStub()
    const ctx = await setup(stub)
    await call(ctx, 'a2a_send', { peer: 'pi', message: 'x' })
    expect(stub.dispatch).toHaveBeenCalledWith(expect.objectContaining({ agent: 'pi', skill: 'code-dev', mode: 'direct' }))

    const empty = bridgeStub()
    empty.skills?.mockReturnValue([])
    const ctx2 = await setup(empty)
    const failed = await call(ctx2, 'a2a_send', { peer: 'pi', message: 'x' }) as unknown as { isError?: boolean; content: { type: string; text?: string }[] }
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('advertises no skill')
  })

  it('地址不是桥 agent 时退回通用发送，并把 skill 放进元数据', async () => {
    const stub = bridgeStub()
    stub.send.mockResolvedValue({ text: '通用答案', contextId: 'c9' } satisfies A2APeerReply)
    const ctx = await setup(stub)
    await call(ctx, 'a2a_send', { peer: 'http://127.0.0.1:9999/', message: 'x', skill: 'coding' })
    expect(stub.dispatch).not.toHaveBeenCalled()
    expect(stub.send).toHaveBeenCalledWith(expect.objectContaining({
      peer: 'http://127.0.0.1:9999/',
      text: 'x',
      metadata: { skill: 'coding' },
    }))
  })
})
