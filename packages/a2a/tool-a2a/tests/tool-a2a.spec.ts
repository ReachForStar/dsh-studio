import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { A2APeerInfo, A2APeerReply } from '@reachforstar/dsh-a2a'
import * as tool from '../src/index.ts'

const signal = new AbortController().signal
const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.()
})

interface PeerStub {
  readonly inspect: ReturnType<typeof vi.fn>
  readonly send: ReturnType<typeof vi.fn>
}

async function setup(stub: PeerStub): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('a2a', stub as never)
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
