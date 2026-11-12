import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply } from '../src/index.ts'

/** Minimal scripted adapter: every call replies with one fixed line. */
class ReplyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(options: { reject?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin({ name: 'fork-notice', apply })
  if (options.reject === true) {
    await ctx.plugin({ name: 'rejector', apply: (inner: Context) => {
      inner.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' as const }))
    } })
  }
  const adapter = new ReplyAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function forkFrom(ctx: Context, source: Agent, meta: { isSeeded: boolean; origin?: 'subagent' }) {
  const events = [...source.session.snapshotEvents()]
  return await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(`fork-${String(Math.random()).slice(2)}`),
    seed: events,
    inheritedEventCount: source.session.seq,
    meta,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
}

/** All user-message texts in the child-owned part of a session log. */
function ownUserTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents(agent.session.firstLiveSeq)
    .flatMap(event => event.type === 'user/message' ? event.data.content : [])
    .flatMap(block => block.type === 'text' ? [block.text] : [])
}

describe('fork notice', () => {
  it('adds the ownership notice to an ordinary fork before its first model step', async () => {
    const { ctx, adapter } = await harness()
    const source = await ctx.agentLoop.create(SessionId('source'), { provider: 'mock', model: 'mock' })
    source.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, source)

    const fork = await forkFrom(ctx, source, { isSeeded: true })
    const handle = fork.agent
    handle.followup(createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle)

    expect(ownUserTexts(handle).some(text => text.includes('<fork-notice>'))).toBe(true)
    const first = adapter.requests.at(-1)!
    expect(JSON.stringify(first.messages)).toContain('<fork-notice>')
  })

  it('does not add the notice to a subagent child', async () => {
    const { ctx } = await harness()
    const source = await ctx.agentLoop.create(SessionId('source'), { provider: 'mock', model: 'mock' })
    source.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, source)

    const fork = await forkFrom(ctx, source, { isSeeded: true, origin: 'subagent' })
    fork.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, fork.agent)

    expect(ownUserTexts(fork.agent).join('\n')).not.toContain('<fork-notice>')
  })

  it('does not add the notice to a non-seeded session', async () => {
    const { ctx } = await harness()
    const agent = await ctx.agentLoop.create(SessionId('plain'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(ownUserTexts(agent).join('\n')).not.toContain('<fork-notice>')
  })

  it('does not repeat the notice on later turns', async () => {
    const { ctx } = await harness()
    const source = await ctx.agentLoop.create(SessionId('source'), { provider: 'mock', model: 'mock' })
    source.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, source)

    const fork = await forkFrom(ctx, source, { isSeeded: true })
    fork.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, fork.agent)
    fork.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, fork.agent)

    expect(ownUserTexts(fork.agent).filter(text => text.includes('<fork-notice>'))).toHaveLength(1)
  })
})


it('skips the notice when another listener rejects the step', async () => {
  const { ctx } = await harness({ reject: true })
  const source = await ctx.agentLoop.create(SessionId('source'), { provider: 'mock', model: 'mock' })
  source.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, source)

  const fork = await forkFrom(ctx, source, { isSeeded: true })
  expect(ownUserTexts(fork.agent).join('\n')).not.toContain('<fork-notice>')
})
