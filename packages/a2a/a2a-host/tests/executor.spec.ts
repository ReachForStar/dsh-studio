import { describe, expect, it, vi } from 'vitest'
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller'
import { assistantText, DshA2AExecutor, streamText } from '../src/executor.ts'
import type { A2AExecutorContext, A2AStreamSink } from '@reachforstar/dsh-a2a'

type Step = SessionFollowFrame | { readonly waitFor: Promise<void> } | { readonly build: () => SessionFollowFrame }

/** 等到信号被取消就拒绝，用来模拟取消让订阅结束。 */
function abortRace(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('follow aborted'))
      return
    }
    signal.addEventListener('abort', () => { reject(new Error('follow aborted')) }, { once: true })
  })
}

/** 按脚本播放会话帧：`waitFor` 步骤可把订阅卡住到某个事件。 */
async function* playback(steps: readonly Step[], signal: AbortSignal): AsyncGenerator<SessionFollowFrame> {
  for (const step of steps) {
    if ('waitFor' in step) {
      await Promise.race([step.waitFor, abortRace(signal)])
      continue
    }
    yield 'build' in step ? step.build() : step
  }
  await abortRace(signal)
}

function eventFrame(type: string, data: unknown = {}): SessionFollowFrame {
  return { type: 'event', event: { type, data } } as unknown as SessionFollowFrame
}

/** 当前用例铸出的 prompt id：harness 在 prompt 时记录，帧构建时读取。 */
const CURRENT = { requestId: '' }

/** 本轮用户消息：rpcId 与执行器铸的 id 对齐。 */
function ownUserFrame(): Step {
  return { build: () => eventFrame('user/message', { source: { kind: 'user', rpcId: CURRENT.requestId } }) }
}

function deltaFrame(text: string): SessionFollowFrame {
  return { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text } } } as unknown as SessionFollowFrame
}

interface Recorder {
  readonly sink: A2AStreamSink
  readonly statuses: { state: string; text?: string }[]
  readonly artifacts: { artifactId: string; text: string; lastChunk?: boolean }[]
}

function recorder(): Recorder {
  const statuses: { state: string; text?: string }[] = []
  const artifacts: { artifactId: string; text: string; lastChunk?: boolean }[] = []
  return {
    statuses,
    artifacts,
    sink: {
      sendStatus: (state, text) => { statuses.push({ state, ...text === undefined ? {} : { text } }) },
      appendArtifact: (artifactId, _name, text, lastChunk) => {
        artifacts.push({ artifactId, text, ...lastChunk === undefined ? {} : { lastChunk } })
      },
    },
  }
}

function contextOf(taskId = 't1', contextId = 'ctx-1', text = '你好'): A2AExecutorContext {
  return { taskId, contextId, skill: 'default', text, metadata: {}, sink: recorder().sink }
}

interface Harness {
  readonly executor: DshA2AExecutor
  readonly create: ReturnType<typeof vi.fn>
  readonly prompt: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly seen: { frames: SessionFollowFrame[] }
}

function harness(
  steps: readonly Step[],
  options: { cwd?: string; agentPreset?: string; turnTimeoutMs?: number; followThrows?: Error } = {},
): Harness {
  CURRENT.requestId = ''
  const seen = { frames: [] as SessionFollowFrame[] }
  const create = vi.fn(() => Promise.resolve({ sessionId: 's' }))
  const prompt = vi.fn((request: { requestId: string }) => {
    CURRENT.requestId = request.requestId
    return Promise.resolve({ accepted: true as const })
  })
  const cancel = vi.fn(() => ({ accepted: true as const }))
  const sessions = {
    create,
    prompt,
    cancel,
    follow: (_request: unknown, signal: AbortSignal) => {
      if (options.followThrows !== undefined) throw options.followThrows
      return playback(steps, signal)
    },
  }
  const executor = new DshA2AExecutor({
    sessions: sessions as never,
    ...options.cwd === undefined ? {} : { cwd: options.cwd },
    ...options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset },
    ...options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs },
  })
  return { executor, create, prompt, cancel, seen }
}

const FOREIGN_TURN: readonly Step[] = [
  deltaFrame('别的客户端'),
  eventFrame('user/message', { source: { kind: 'user', rpcId: 'someone-else' } }),
  eventFrame('assistant/message', { message: { content: [{ type: 'text', text: '别的答案' }] } }),
  eventFrame('turn/end'),
]

const OUR_TURN: readonly Step[] = [
  ownUserFrame(),
  deltaFrame('你'),
  deltaFrame('好'),
  eventFrame('assistant/message', { message: { content: [{ type: 'text', text: '你好' }] } }),
  eventFrame('turn/end'),
]

describe('DshA2AExecutor.onMessage', () => {
  it('把流式增量写进工件，并在本轮结束时收尾', async () => {
    const { executor, create, prompt } = harness(OUR_TURN)
    const context = contextOf()
    await executor.onMessage(context)
    expect(create).toHaveBeenCalledExactlyOnceWith({ sessionId: 'ctx-1' })
    expect(prompt).toHaveBeenCalledExactlyOnceWith({
      requestId: expect.any(String) as string,
      sessionId: 'ctx-1',
      mode: 'queue',
      content: [{ type: 'text', text: '你好' }],
    }, expect.any(AbortSignal))
    expect(typeof context.sink.sendStatus).toBe('function')
  })

  it('跳过别的客户端正在跑的那一轮，只消费本轮增量', async () => {
    const { executor } = harness([...FOREIGN_TURN, ...OUR_TURN])
    const sink = recorder()
    await executor.onMessage({ ...contextOf(), sink: sink.sink })
    expect(sink.statuses).toEqual([{ state: 'TASK_STATE_WORKING' }])
    expect(sink.artifacts).toEqual([
      { artifactId: 'reply', text: '你' },
      { artifactId: 'reply', text: '好' },
    ])
  })

  it('没有增量时用本轮最后的 assistant 文本收尾', async () => {
    const { executor } = harness([
      ownUserFrame(),
      eventFrame('assistant/message', { message: { content: [{ type: 'text', text: '只有工具' }] } }),
      eventFrame('turn/end'),
    ])
    const sink = recorder()
    await executor.onMessage({ ...contextOf(), sink: sink.sink })
    expect(sink.artifacts).toEqual([{ artifactId: 'reply', text: '只有工具', lastChunk: true }])
  })

  it('本轮没有文本时不写空工件', async () => {
    const { executor } = harness([ownUserFrame(), eventFrame('turn/end')])
    const sink = recorder()
    await executor.onMessage({ ...contextOf(), sink: sink.sink })
    expect(sink.artifacts).toEqual([])
  })

  it('把会话位置与预设透传给 create', async () => {
    const { executor, create } = harness(OUR_TURN, { cwd: '/srv/work', agentPreset: 'dev' })
    await executor.onMessage(contextOf())
    expect(create).toHaveBeenCalledWith({ sessionId: 'ctx-1', cwd: '/srv/work', agentPreset: 'dev' })
  })

  it('超出回合预算时报错并停止等待', async () => {
    const never = new Promise<void>(() => {})
    const { executor } = harness([ownUserFrame(), deltaFrame('半'), { waitFor: never }], { turnTimeoutMs: 10 })
    const sink = recorder()
    await expect(executor.onMessage({ ...contextOf(), sink: sink.sink })).rejects.toThrow(/exceeded its 10ms turn budget/)
    expect(sink.artifacts).toEqual([{ artifactId: 'reply', text: '半' }])
  })

  it('取消任务会中止本轮并请求会话取消', async () => {
    const never = new Promise<void>(() => {})
    const { executor, cancel } = harness([ownUserFrame(), { waitFor: never }])
    const pending = executor.onMessage(contextOf('t9', 'ctx-9'))
    await new Promise(resolve => setTimeout(resolve, 10))
    executor.onCancel({ taskId: 't9', contextId: 'ctx-9' })
    await expect(pending).rejects.toThrow(/follow aborted/)
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'ctx-9' })
  })

  it('取消未运行的任务只请求会话取消', () => {
    const { executor, cancel } = harness([])
    executor.onCancel({ taskId: 'missing', contextId: 'ctx-2' })
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'ctx-2' })
  })

  it('follow 直接抛错时把错误透出', async () => {
    const { executor } = harness([], { followThrows: new Error('follow failed') })
    await expect(executor.onMessage(contextOf())).rejects.toThrow('follow failed')
  })
})

describe('assistantText', () => {
  it('只拼接 text 块', () => {
    expect(assistantText(null)).toBe('')
    expect(assistantText('nope')).toBe('')
    expect(assistantText({})).toBe('')
    expect(assistantText({ message: {} })).toBe('')
    expect(assistantText({ message: { content: 'nope' } })).toBe('')
    expect(assistantText({ message: { content: [{ type: 'text', text: 'a' }, { type: 'tool-call' }, null, { type: 'text', text: 7 }] } })).toBe('a')
  })
})

describe('streamText', () => {
  it('只认 text-delta 分片', () => {
    expect(streamText({ type: 'start' } as never)).toBe('')
    expect(streamText({ type: 'chunk', chunk: { type: 'usage' } } as never)).toBe('')
    expect(streamText({ type: 'chunk', chunk: { type: 'text-delta', text: 'x' } } as never)).toBe('x')
    expect(streamText({ type: 'chunk', chunk: { type: 'text-delta', text: 3 } } as never)).toBe('')
    expect(streamText({ type: 'chunk', chunk: null } as never)).toBe('')
  })
})
