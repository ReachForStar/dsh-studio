import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { A2ABridgeConfig, A2ADispatchRequest, A2APeerReply } from '@reachforstar/dsh-a2a'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as xingchen from '../src/index.ts'
import type { XingchenConfig } from '../src/index.ts'
import * as xingchenClear from '../src/clear.ts'
import { routeXingchen } from '../src/route.ts'

const disposers: (() => Promise<void>)[] = []
const signal = new AbortController().signal

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.()
})

interface A2AStub {
  readonly inspect: ReturnType<typeof vi.fn>
  readonly list: ReturnType<typeof vi.fn>
  readonly send: ReturnType<typeof vi.fn>
  readonly skills: ReturnType<typeof vi.fn>
  readonly bridgeConfig?: A2ABridgeConfig
  readonly dispatch: Mock<(request: A2ADispatchRequest) => Promise<unknown>>
}

/** Arguments of one recorded `a2a.send` call. */
interface SentCall {
  readonly peer: string
  readonly text: string
  readonly contextId?: string
}

/** The arguments one `a2a.send` call was recorded with, failing loud when absent. */
function sentCall(stub: A2AStub, index: number): SentCall {
  const call = stub.send.mock.calls[index]?.[0] as SentCall | undefined
  if (call === undefined) throw new Error(`a2a.send call ${String(index)} was not recorded`)
  return call
}

function a2aStub(reply: Partial<A2APeerReply> = {}, peers: readonly string[] = [], bridge?: A2ABridgeConfig): A2AStub {
  return {
    inspect: vi.fn(() => Promise.resolve([])),
    list: vi.fn(() => [...peers]),
    send: vi.fn(() => Promise.resolve({ text: '专家回答', ...reply })),
    skills: vi.fn((agent: string) => (bridge?.skills as Record<string, string[]> | undefined)?.[agent] ?? []),
    ...bridge === undefined ? {} : { bridgeConfig: bridge },
    dispatch: vi.fn((_request: A2ADispatchRequest) => Promise.resolve({ text: '桥回答', agent: 'claude-code', skill: 'code-review', mode: 'direct' })),
  }
}

/** 一份桥配置：三个 agent 的端口与各自的 skill。 */
const BRIDGE = {
  apiKey: '',
  agents: {
    pi: { port: 9310, defaultWorkspace: '' },
    'claude-code': { port: 9320, defaultWorkspace: '' },
    opencode: { port: 9330, defaultWorkspace: '' },
  },
  skills: { pi: ['code-dev', 'analysis'], 'claude-code': ['code-review', 'coding'], opencode: ['analysis'] },
  bus: { bootstrapServers: ['127.0.0.1:9092'], taskTopic: 'a2a.task', eventTopic: 'a2a.event', dlqTopic: 'a2a.dlq', partitions: 6, maxAttempts: 3 },
  piModel: '',
  opencodeModel: '',
  idleMs: 1_800_000,
  taskTimeoutMs: 600_000,
} as unknown as A2ABridgeConfig

/** One live idle agent with a store-created session, as command handlers expect. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = createInboxStub()
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

interface SubagentStub {
  readonly start: ReturnType<typeof vi.fn>
}

/** A `ctx.subagents` stub whose spawned seat answers with fixed text. */
function subagentStub(text = '本机专家回答'): SubagentStub {
  return {
    start: vi.fn(() => Promise.resolve({
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }),
      dispose: () => Promise.resolve(),
    })),
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly a2a: A2AStub
  readonly subagents: SubagentStub
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/**
 * Mount the routing stack with stubbed seams.
 * @param stub - A2A seam stub used by `a2a`-mode seats.
 * @param mode - `a2a` pins every seat to its peer; `auto` (the default) lets a
 *   configured peer decide, which stays local on a deployment without peers.
 */
async function harness(stub: A2AStub = a2aStub(), mode: 'auto' | 'a2a' = 'a2a', extra: XingchenConfig = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  ctx.provide('a2a', stub as never)
  const subagents = subagentStub()
  ctx.provide('subagents', subagents as never)
  const config: XingchenConfig = mode === 'a2a'
    ? { ...extra, seats: { tianquan: { mode: 'a2a' }, yaoguang: { mode: 'a2a' }, tianliang: { mode: 'a2a' }, ...extra.seats } }
    : extra
  const plugin = await ctx.plugin(xingchen, config)
  disposers.push(async () => { await plugin.dispose() })
  const { agent, session } = stubAgent(ctx, `xingchen-${Math.random()}`)
  await ctx.agents.register(agent)
  return { ctx, agent, session, a2a: stub, subagents, plugin }
}

let toolCounter = 0
function runTool(ctx: Context, agent: Agent, args: unknown): Promise<unknown> {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`xingchen-call-${String(++toolCounter)}`),
    name: 'xingchen_route',
    arguments: args,
    agent,
  })
}

/** Model-facing outcome of one tool call, including the failure envelope. */
interface ToolOutcome {
  readonly content: readonly { type: string; text?: string }[]
  readonly isError?: boolean
}

function textOf(result: ToolOutcome): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('routeXingchen 启发式路由', () => {
  it('斜杠命令显式指定角色', () => {
    expect(routeXingchen('/review 评估一下架构')).toBe('tianquan')
    expect(routeXingchen('/bug 崩溃了')).toBe('yaoguang')
    expect(routeXingchen('/planning 排个期')).toBe('tianliang')
    expect(routeXingchen('/review')).toBe('tianquan')
  })

  it('命令需要词边界，且只认行首', () => {
    expect(routeXingchen('/reviewer 帮我看看')).toBe('qiming')
    expect(routeXingchen('path/review 在文件里')).toBe('qiming')
    expect(routeXingchen('看看 /bug 用法')).toBe('qiming')
  })

  it('两个以上不同关键词命中才路由，单个信号留给启明', () => {
    expect(routeXingchen('帮我审查一下架构')).toBe('tianquan')
    expect(routeXingchen('审查一下这段代码')).toBe('qiming')
    expect(routeXingchen('这个 bug 崩溃了')).toBe('yaoguang')
    expect(routeXingchen('修一下这个 bug')).toBe('qiming')
    expect(routeXingchen('做个迭代排期')).toBe('tianliang')
    expect(routeXingchen('写个函数')).toBe('qiming')
  })

  it('英文关键词按整词匹配', () => {
    expect(routeXingchen('reproduce the crash and find the root cause')).toBe('yaoguang')
    expect(routeXingchen('debug the module')).toBe('qiming')
    expect(routeXingchen('plan the sprint and breakdown')).toBe('tianliang')
  })

  it('多个角色信号同时命中时取分数最高者', () => {
    expect(routeXingchen('这个 bug 崩溃了，帮我审查一下架构并做排期')).toBe('qiming')
    expect(routeXingchen('复现这个崩溃的根因并给出堆栈')).toBe('yaoguang')
  })
})

describe('@reachforstar/dsh-xingchen 注册', () => {
  it('Loader 可解包模块导出（无 default 导出）', () => {
    expect(xingchen.name).toBe('xingchen')
    expect('default' in xingchen).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(xingchen)).toBe(xingchen)
  })

  it('注册命令、工具与投影；卸载后全部撤出', async () => {
    const test = await harness()
    expect(test.ctx.xingchen).toBeDefined()
    expect(test.ctx.commands.list(test.agent).map(entry => entry.name)).toEqual(
      expect.arrayContaining(['review', 'bug', 'planning']),
    )
    expect(test.ctx.commands.find(test.agent, 'review')?.description).toContain('天权')
    expect(test.ctx.tools.get('xingchen_route')).toBeDefined()
    expect(test.ctx.sessionProjections.stateOf(test.session, 'xingchen')).toEqual({
      lastRole: null,
      dispatchCount: 0,
      lastTurnReason: null,
    })
    await test.plugin.dispose()
    expect(test.ctx.tools.get('xingchen_route')).toBeUndefined()
    expect(test.ctx.commands.find(test.agent, 'review')).toBeUndefined()
  })

  it('系统提示词包含星域路由纪律', async () => {
    const test = await harness()
    const assembly = await test.ctx.systemPrompt.assemble({ agent: test.agent })
    const section = assembly.sections.find(entry => entry.name === 'xingchen:routing')
    expect(section?.text).toContain('星域协作')
    expect(section?.text).toContain('xingchen_route')
  })
})

describe('/review /bug /planning 人面命令', () => {
  it('把任务连同角色章程派发给对应 A2A 对等端', async () => {
    const test = await harness()
    const execution = await test.ctx.commands.execute(
      test.agent, '/review 评估这个 diff', [], signal,
    )
    expect(execution?.result).toEqual({
      kind: 'success',
      text: '天权 已处理：\n\n专家回答',
    })
    expect(test.a2a.send).toHaveBeenCalledTimes(1)
    const call = sentCall(test.a2a, 0)
    expect(call.peer).toBe('claude-code')
    expect(call.text).toContain('你是天权')
    expect(call.text).toContain('评估这个 diff')
  })

  it('把席位答复作为免轮次的 assistant 消息落进会话事件', async () => {
    const test = await harness()
    await test.ctx.commands.execute(test.agent, '/planning 分波交付', [], signal)
    const peer = test.session.ownEvents()
      .filter(event => (event as { type: string }).type === 'assistant/peer-message')
    expect(peer).toHaveLength(1)
    const message = (peer[0] as { data: { message: {
      id: string
      role: string
      source: Record<string, unknown>
      content: unknown[]
    } } }).data.message
    expect(message.role).toBe('assistant')
    expect(message.id).not.toBe('')
    // The seat produced the answer, so the source names it and never this Session's model.
    expect(message.source).toMatchObject({ kind: 'a2a-seat', role: 'tianliang' })
    expect(message.source).not.toHaveProperty('provider')
    expect(message.content).toEqual([{ type: 'text', text: '专家回答' }])
  })

  it('bug 与 planning 分别路由到瑶光与天梁', async () => {    const test = await harness()
    await test.ctx.commands.execute(test.agent, '/bug 复现崩溃', [], signal)
    await test.ctx.commands.execute(test.agent, '/planning 分波交付', [], signal)
    expect(sentCall(test.a2a, 0).peer).toBe('pi')
    expect(sentCall(test.a2a, 1).peer).toBe('opencode')
  })

  it('空任务回用法错误，不发起调用', async () => {
    const test = await harness()
    const execution = await test.ctx.commands.execute(test.agent, '/review', [], signal)
    expect(execution?.result).toEqual({
      kind: 'error',
      text: '用法：/review <任务描述>（架构评估与代码审查）',
    })
    expect(test.a2a.send).not.toHaveBeenCalled()
  })

  it('对等端不可达时以错误结果落定', async () => {
    const stub = a2aStub()
    stub.send.mockRejectedValue(new Error('no A2A peer named "pi"; configured peers are (none)'))
    const test = await harness(stub)
    const execution = await test.ctx.commands.execute(test.agent, '/bug 复现崩溃', [], signal)
    expect(execution?.result.kind).toBe('error')
    expect((execution?.result as { text: string }).text).toContain('no A2A peer named "pi"')
  })

  it('同一会话对同一角色的多轮派发续接对端会话', async () => {
    const test = await harness(a2aStub({ contextId: 'peer-ctx-1' }))
    await test.ctx.commands.execute(test.agent, '/bug 第一轮', [], signal)
    await test.ctx.commands.execute(test.agent, '/bug 第二轮', [], signal)
    const second = sentCall(test.a2a, 1)
    expect(second.contextId).toBe('peer-ctx-1')
  })

  it('不同角色各自保持独立的对端会话', async () => {
    const test = await harness(a2aStub({ contextId: 'peer-ctx' }))
    await test.ctx.commands.execute(test.agent, '/bug 瑶光一轮', [], signal)
    await test.ctx.commands.execute(test.agent, '/review 天权一轮', [], signal)
    const second = sentCall(test.a2a, 1)
    expect(second.contextId).toBeUndefined()
  })
})

describe('本机专家席（默认）', () => {
  it('命令派发走 ctx.subagents，并带上角色章程', async () => {
    const test = await harness(a2aStub(), 'auto')
    const execution = await test.ctx.commands.execute(test.agent, '/review 评估这个 diff', [], signal)
    expect(execution?.result).toEqual({ kind: 'success', text: '天权 已处理：\n\n本机专家回答' })
    expect(test.a2a.send).not.toHaveBeenCalled()
    expect(test.subagents.start).toHaveBeenCalledTimes(1)
    const [provider, request] = test.subagents.start.mock.calls[0] as [string, {
      prompt: { type: string; text: string }[]
      parent: Agent
    }]
    expect(provider).toBe('spawn')
    expect(request.parent).toBe(test.agent)
    expect(request.prompt[0]?.text).toContain('你是天权')
    expect(request.prompt[0]?.text).toContain('评估这个 diff')
  })

  it('工具委派返回本机席位的回答', async () => {
    const test = await harness(a2aStub(), 'auto')
    const result = await runTool(test.ctx, test.agent, { role: 'yaoguang', task: '复现崩溃' }) as ToolOutcome
    expect(result.isError).toBe(false)
    expect(textOf(result)).toBe('[瑶光] 本机专家回答')
    expect(test.a2a.send).not.toHaveBeenCalled()
    expect(test.subagents.start).toHaveBeenCalledTimes(1)
  })

  it('本机席位超时后释放子运行并以错误结果落定，不再无限等待', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.provide('a2a', a2aStub() as never)
    const stuck = {
      result: new Promise(() => {}),
      dispose: vi.fn(() => Promise.resolve()),
    }
    const slow = { start: vi.fn(() => Promise.resolve(stuck)) }
    ctx.provide('subagents', slow as never)
    const plugin = await ctx.plugin(xingchen, { seats: { tianquan: { timeoutMs: 5 } } })
    disposers.push(async () => { await plugin.dispose() })
    const { agent } = stubAgent(ctx, `xingchen-timeout-${Math.random()}`)
    await ctx.agents.register(agent)
    const execution = await ctx.commands.execute(agent, '/review 评估', [], signal)
    expect(execution?.result.kind).toBe('error')
    expect((execution?.result as { text: string }).text).toContain('未完成')
    expect(stuck.dispose).toHaveBeenCalledTimes(1)
  })

  it('对等端已配置时席位默认走 a2a，未配置时留在本机', async () => {
    const bridged = await harness(a2aStub({}, ['claude-code', 'pi', 'opencode']), 'auto')
    await bridged.ctx.commands.execute(bridged.agent, '/review 评估', [], signal)
    expect(bridged.a2a.send).toHaveBeenCalledTimes(1)
    expect(bridged.subagents.start).not.toHaveBeenCalled()
    const plain = await harness(a2aStub(), 'auto')
    await plain.ctx.commands.execute(plain.agent, '/review 评估', [], signal)
    expect(plain.a2a.send).not.toHaveBeenCalled()
    expect(plain.subagents.start).toHaveBeenCalledTimes(1)
  })

  it('seats.<role>.model 解析成子代理模型路由；格式不对则拒绝装配', async () => {
    /** A bare context with the stubs the routing service injects. */
    const bare = async (): Promise<{ ctx: Context; subagents: SubagentStub }> => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(CommandRuntime)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      ctx.provide('a2a', a2aStub() as never)
      const subagents = subagentStub()
      ctx.provide('subagents', subagents as never)
      return { ctx, subagents }
    }
    const { ctx, subagents } = await bare()
    const plugin = await ctx.plugin(xingchen, { seats: { tianliang: { model: 'amax/qwen-3.8-27B' } } })
    disposers.push(async () => { await plugin.dispose() })
    const { agent } = stubAgent(ctx, `xingchen-seat-${Math.random()}`)
    await ctx.agents.register(agent)
    await ctx.commands.execute(agent, '/planning 排期', [], signal)
    const request = subagents.start.mock.calls[0]?.[1] as { agentOptions?: { provider: string; model: string } }
    expect(request.agentOptions).toEqual({ provider: 'amax', model: 'qwen-3.8-27B' })
    // A malformed model route fails activation instead of silently running the
    // parent's route. A fresh context is required: Cordis reuses the activation
    // of a plugin already mounted on this one.
    const invalid = await bare()
    await invalid.ctx.plugin(xingchen, { seats: { tianquan: { model: 'no-slash' } } })
    expect(invalid.ctx.get('xingchen') === undefined).toBe(true)
  })
})

describe('xingchen_route 委派工具', () => {
  it('把自包含任务委派给专家角色并带角色前缀返回', async () => {
    const test = await harness()
    const result = await runTool(test.ctx, test.agent, { role: 'tianquan', task: '称量这段架构' }) as {
      content: readonly { type: string; text?: string }[]
    }
    expect(test.a2a.send).toHaveBeenCalledTimes(1)
    expect(textOf(result)).toBe('[天权] 专家回答')
  })

  it('角色与任务在工具层校验，失败以错误结果落定', async () => {
    const test = await harness()
    const wrongRole = await runTool(test.ctx, test.agent, { role: 'qiming', task: '写个函数' }) as ToolOutcome
    expect(wrongRole.isError).toBe(true)
    expect(textOf(wrongRole)).toContain('"role" must be one of')
    const emptyTask = await runTool(test.ctx, test.agent, { role: 'yaoguang', task: '  ' }) as ToolOutcome
    expect(emptyTask.isError).toBe(true)
    expect(textOf(emptyTask)).toContain('requires a non-empty self-contained task')
    expect(test.a2a.send).not.toHaveBeenCalled()
  })

  it('presentCall 出角色卡片，参数不符时回退通用卡片', async () => {
    const test = await harness()
    const definition = test.ctx.tools.get('xingchen_route')
    expect(definition?.presentCall?.({ role: 'yaoguang', task: '复现崩溃' })).toEqual({
      card: 'generic',
      title: '星域 · 瑶光',
      kind: 'other',
      rawInput: '复现崩溃',
    })
    expect(definition?.presentCall?.({ role: 'tianquan', task: '称量架构' })?.title).toBe('星域 · 天权')
    // Replay of logged arguments from an older schema must not throw or render a
    // half-built card.
    expect(definition?.presentCall?.({ role: 'weird', task: 'x' })).toBeUndefined()
  })
})

describe('xingchen 会话投影', () => {
  it('折叠命令派发、工具委派与轮次终止', async () => {
    const test = await harness()
    const { session } = test
    session.append('turn/start', { turn: 1 })
    session.append('command/run', {
      commandId: 'cmd-1' as never,
      name: 'review',
      args: '评估',
      source: { kind: 'user' },
    })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('call-fold-1'),
      name: 'xingchen_route',
      arguments: JSON.stringify({ role: 'yaoguang', task: '复现' }),
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(test.ctx.sessionProjections.stateOf(session, 'xingchen')).toEqual({
      lastRole: 'yaoguang',
      dispatchCount: 2,
      lastTurnReason: { kind: 'completed' },
    })
  })

  it('忽略非星域命令与参数异常的委派调用', async () => {
    const test = await harness()
    const { session } = test
    session.append('command/run', {
      commandId: 'cmd-2' as never,
      name: 'compact',
      source: { kind: 'user' },
    })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('call-fold-2'),
      name: 'xingchen_route',
      arguments: '{broken',
    })
    expect(test.ctx.sessionProjections.stateOf(session, 'xingchen')).toEqual({
      lastRole: null,
      dispatchCount: 0,
      lastTurnReason: null,
    })
  })

  it('手动停止的轮次终止回投影为 user 原因的 aborted', async () => {
    const test = await harness()
    test.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(test.ctx.sessionProjections.stateOf(test.session, 'xingchen')?.lastTurnReason)
      .toEqual({ kind: 'aborted', cause: 'user' })
  })
})

describe('turnReasonOf 终止原因裁剪', () => {
  it('未建模的合并扩展类型映射为通用错误标签', () => {
    expect(xingchen.turnReasonOf({ kind: 'custom-reason' } as unknown as TurnEndReason))
      .toEqual({ kind: 'error' })
  })
})

describe('@reachforstar/dsh-xingchen/clear', () => {
  interface ClearHarness {
    readonly ctx: Context
    readonly agent: Agent
    readonly compactNow: ReturnType<typeof vi.fn>
  }

  async function clearHarness(compactNow: ReturnType<typeof vi.fn>): Promise<ClearHarness> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.provide('compaction', { compactNow } as never)
    const plugin = await ctx.plugin(xingchenClear)
    disposers.push(async () => { await plugin.dispose() })
    const { agent } = stubAgent(ctx, `xingchen-clear-${Math.random()}`)
    await ctx.agents.register(agent)
    return { ctx, agent, compactNow }
  }

  it('注册 /clear 并在无参数时执行全量压缩', async () => {
    const test = await clearHarness(vi.fn(() => Promise.resolve({
      shadowedSeqs: [1, 2],
      shadowedTokenCount: 120,
      summarySeq: 3,
    })))
    expect(xingchenClear.name).toBe('xingchen-clear')
    expect('default' in xingchenClear).toBe(false)
    const execution = await test.ctx.commands.execute(test.agent, '/clear', [], signal)
    expect(execution?.result).toEqual({
      kind: 'success',
      text: '上下文已清理：2 条历史被压缩为摘要（约 120 tokens）。',
      sourceEventSeq: 3,
    })
    expect(test.compactNow).toHaveBeenCalledTimes(1)
  })

  it('无可压缩历史时给出说明；带参数时回用法', async () => {
    const test = await clearHarness(vi.fn(() => Promise.resolve(null)))
    expect((await test.ctx.commands.execute(test.agent, '/clear', [], signal))?.result).toEqual({
      kind: 'success',
      text: '暂无可清理的上下文。',
    })
    expect((await test.ctx.commands.execute(test.agent, '/clear 全部', [], signal))?.result).toEqual({
      kind: 'error',
      text: 'Usage: /clear (no arguments)',
    })
    expect(test.compactNow).toHaveBeenCalledTimes(1)
  })

  it('压缩域错误落定为错误结果', async () => {
    const test = await clearHarness(vi.fn(() => Promise.reject(new ManualCompactionError('busy', 'busy'))))
    const execution = await test.ctx.commands.execute(test.agent, '/clear', [], signal)
    expect(execution?.result).toEqual({
      kind: 'error',
      text: '上下文清理失败（busy）；该轮尝试已记录在会话日志中。',
    })
  })
})

describe('进度上报 xingchen/dispatch-progress', () => {
  function progressEvents(session: { ownEvents(): readonly unknown[] }): {
    role: string
    callId?: unknown
    commandId?: unknown
    agent: string
    skill: string
    mode: string
    state?: string
    text: string
  }[] {
    return session.ownEvents()
      .filter(event => (event as { type: string }).type === 'xingchen/dispatch-progress')
      .map(event => (event as { data: never }).data)
  }

  it('命令路径把对端进度写入会话事件，终态强制补报一次并带 commandId', async () => {
    const stub = a2aStub({}, ['claude-code'], BRIDGE)
    stub.dispatch.mockImplementation((request: A2ADispatchRequest) => {
      request.onProgress?.({ state: 'TASK_STATE_WORKING', text: '第一段' })
      request.onProgress?.({ state: 'TASK_STATE_WORKING', text: '第一段' + 'a'.repeat(250) })
      return Promise.resolve({
        text: '第一段' + 'a'.repeat(250),
        state: 'TASK_STATE_COMPLETED',
        contextId: 'c1',
        agent: 'claude-code',
        skill: 'code-review',
        mode: 'direct',
      })
    })
    const test = await harness(stub)
    await test.ctx.commands.execute(test.agent, '/review 评估一下', [], signal)
    const events = progressEvents(test.session)
    expect(events).toEqual([
      expect.objectContaining({ role: 'tianquan', agent: 'claude-code', skill: 'code-review', mode: 'direct', state: 'TASK_STATE_WORKING', text: '第一段' }),
      expect.objectContaining({ state: 'TASK_STATE_WORKING', text: '第一段' + 'a'.repeat(250) }),
      expect.objectContaining({ state: 'TASK_STATE_COMPLETED', text: '第一段' + 'a'.repeat(250) }),
    ])
    expect(events.every(event => typeof event.commandId === 'string' && event.commandId.length > 0)).toBe(true)
    expect(events.every(event => event.callId === undefined)).toBe(true)
  })

  it('工具路径的进度事件带本次调用的 callId', async () => {
    const stub = a2aStub({}, ['claude-code'], BRIDGE)
    stub.dispatch.mockImplementation((request: A2ADispatchRequest) => {
      request.onProgress?.({ state: 'TASK_STATE_WORKING', text: '进行中' })
      return Promise.resolve({ text: '结论', state: 'TASK_STATE_COMPLETED', contextId: 'c2', agent: 'claude-code', skill: 'code-review', mode: 'direct' })
    })
    const test = await harness(stub)
    const before = toolCounter
    await runTool(test.ctx, test.agent, { role: 'tianquan', task: '称量这段架构' })
    const events = progressEvents(test.session)
    expect(events).toHaveLength(2)
    expect(events.every(event => event.callId === `xingchen-call-${String(before + 1)}`)).toBe(true)
    expect(events.every(event => event.commandId === undefined)).toBe(true)
  })

  it('节流：状态与文本都小步前进时只在首尾各报一次', async () => {
    const stub = a2aStub({}, ['claude-code'], BRIDGE)
    stub.dispatch.mockImplementation((request: A2ADispatchRequest) => {
      for (let i = 1; i <= 50; i += 1) request.onProgress?.({ state: 'TASK_STATE_WORKING', text: 'a'.repeat(i) })
      return Promise.resolve({ text: 'a'.repeat(50), state: 'TASK_STATE_COMPLETED', contextId: 'c3', agent: 'claude-code', skill: 'code-review', mode: 'direct' })
    })
    const test = await harness(stub)
    await test.ctx.commands.execute(test.agent, '/review 评估一下', [], signal)
    const events = progressEvents(test.session)
    expect(events.map(event => ({ state: event.state, text: event.text }))).toEqual([
      { state: 'TASK_STATE_WORKING', text: 'a' },
      { state: 'TASK_STATE_COMPLETED', text: 'a'.repeat(50) },
    ])
  })

  it('本机席位不产生进度事件；失败态的命令落定为错误结果', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.provide('a2a', a2aStub() as never)
    const failed = { start: vi.fn(() => Promise.resolve({
      result: Promise.resolve({ stopReason: 'error', output: [] }),
      dispose: vi.fn(() => Promise.resolve()),
    })) }
    ctx.provide('subagents', failed as never)
    const plugin = await ctx.plugin(xingchen, {})
    disposers.push(async () => { await plugin.dispose() })
    const { agent } = stubAgent(ctx, `xingchen-fail-${Math.random()}`)
    await ctx.agents.register(agent)
    const execution = await ctx.commands.execute(agent, '/review 评估一下', [], signal)
    expect(progressEvents(agent.session)).toEqual([])
    const result = execution?.result as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toContain('failed')
    expect(failed.start).toHaveBeenCalledTimes(1)
  })
})

describe('席位走 a2a-bridge 方案', () => {
  it('桥 agent 走 dispatch，带上角色 skill 与通道，并续接对端会话', async () => {
    const stub = a2aStub({}, ['claude-code'], BRIDGE)
    stub.dispatch.mockResolvedValue({ text: '天权结论', contextId: 'bridge-ctx', state: 'TASK_STATE_COMPLETED', agent: 'claude-code', skill: 'coding', mode: 'bus' })
    const test = await harness(stub, 'a2a', {
      peers: { tianquan: 'claude-code' },
      seats: { tianquan: { mode: 'a2a', skill: 'coding', channel: 'bus' } },
    })
    await test.ctx.commands.execute(test.agent, '/review 审查一下', [], signal)
    expect(stub.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agent: 'claude-code',
      skill: 'coding',
      mode: 'bus',
      wait: true,
    }))
    expect(stub.send).not.toHaveBeenCalled()
    await test.ctx.commands.execute(test.agent, '/review 再审一次', [], signal)
    expect(stub.dispatch.mock.calls[1]?.[0]).toMatchObject({ contextId: 'bridge-ctx' })
  })

  it('未配置 skill 时按角色取默认值：天权审查、瑶光与天梁调研分析', async () => {
    const stub = a2aStub({}, ['pi', 'claude-code', 'opencode'], BRIDGE)
    const test = await harness(stub, 'a2a', {
      peers: { tianquan: 'claude-code', yaoguang: 'pi', tianliang: 'opencode' },
    })
    for (const name of ['review', 'bug', 'planning']) {
      await test.ctx.commands.execute(test.agent, `/${name} 做点事`, [], signal)
    }
    expect(stub.dispatch.mock.calls.map(call => (call[0] as { skill: string }).skill))
      .toEqual(['code-review', 'analysis', 'analysis'])
    expect(stub.dispatch.mock.calls.map(call => (call[0] as { mode: string }).mode))
      .toEqual(['direct', 'direct', 'direct'])
  })

  it('对等端不在桥里时退回通用发送，并把 skill 放进元数据', async () => {
    const stub = a2aStub({ text: '通用回答' }, ['custom'], BRIDGE)
    const test = await harness(stub, 'a2a', { peers: { tianquan: 'custom' } })
    await test.ctx.commands.execute(test.agent, '/review 看看', [], signal)
    expect(stub.dispatch).not.toHaveBeenCalled()
    expect(sentCall(stub, 0)).toMatchObject({ peer: 'custom' })
    expect(stub.send.mock.calls[0]?.[0]).toMatchObject({ metadata: { skill: 'code-review' } })
  })

  it('席位以失败态结束时命令落定为错误结果', async () => {
    const stub = a2aStub({ text: 'fetch failed', state: 'TASK_STATE_FAILED' })
    const test = await harness(stub)
    const execution = await test.ctx.commands.execute(test.agent, '/bug 重现一下', [], signal)
    const result = execution?.result as { kind: string; text: string }
    expect(result.kind).toBe('error')
    expect(result.text).toContain('TASK_STATE_FAILED')
    expect(result.text).toContain('fetch failed')
  })
})
