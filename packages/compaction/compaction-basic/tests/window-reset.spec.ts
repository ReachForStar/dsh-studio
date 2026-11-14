/** Window-reset compaction authors a local card instead of a summarization call. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'mock'
const PROMPT = 'older conversation history '.repeat(60)

class TextAdapter extends LlmAdapter {
  readonly requests: RequestMessage[][] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: { messages: readonly RequestMessage[] }): AsyncIterable<StreamChunk> {
    this.requests.push([...options.messages])
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(
  windowReset: boolean,
): Promise<{ ctx: Context; agent: Agent; compact: BasicCompactionEngine; adapter: TextAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new TextAdapter()
  ctx.llm.registerAdapter([MODEL], adapter)
  const compact = new BasicCompactionEngine(ctx, { auto: false, windowReset })
  const agent = await ctx.agentLoop.create(SessionId(`window-${String(windowReset)}`), { provider: MODEL, model: MODEL })
  return { ctx, agent, compact, adapter }
}

function lastSummary(session: Agent['session']): { text: string; provider: string; model: string } {
  const event = [...session.snapshotEvents()].reverse().find(candidate => candidate.type === 'compaction/summary')
  if (event?.type !== 'compaction/summary') throw new Error('no summary in the session')
  return {
    text: event.data.summary.map(block => block.type === 'text' ? block.text : '').join(''),
    provider: event.data.provider,
    model: event.data.model,
  }
}

describe('windowReset compaction', () => {
  it('authors the goal and most recent request locally without calling a model', async () => {
    const { ctx, agent, compact, adapter } = await harness(true)
    ctx.provide('goals', { get: () => ({ objective: 'Ship the release' }) } as never)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: PROMPT }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'remember the migration note' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const result = await compact.compactNow(agent, new AbortController().signal)

    expect(result).not.toBeNull()
    expect(adapter.requests).toHaveLength(2)
    const summary = lastSummary(agent.session)
    expect(summary.provider).toBe('local')
    expect(summary.model).toBe('window-reset')
    expect(summary.text).toContain('Current goal: Ship the release')
    expect(summary.text).toContain('Most recent request: remember the migration note')
  })

  it('falls back to a route-less card when no goal or request remains', async () => {
    const { agent, compact } = await harness(true)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: PROMPT }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const result: CompactionResult | null = await compact.compactNow(agent, new AbortController().signal)

    expect(result?.shadowedSeqs.length).toBeGreaterThan(0)
    expect(lastSummary(agent.session).text).toContain('restarted its context window')
  })

  it('keeps the model summary when window reset is off', async () => {
    const { agent, compact, adapter } = await harness(false)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: PROMPT }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const result = await compact.compactNow(agent, new AbortController().signal)

    expect(result).not.toBeNull()
    expect(adapter.requests).toHaveLength(2)
    expect(lastSummary(agent.session).provider).toBe(MODEL)
  })
})
