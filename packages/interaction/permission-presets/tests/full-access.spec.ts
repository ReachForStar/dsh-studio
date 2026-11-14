/**
 * The approval full-access commit as a product action: a pending prompt cites
 * its own identity through `/full-access`, the service records a receipt for
 * the input pending at commit time, and the preset service applies the
 * configured destination. A repeated commit reuses the receipt, and a prompt
 * that already settled is refused.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

async function harness(): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(CommandRuntime)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('full-access tests do not execute bash') },
    run() { throw new Error('full-access tests do not execute bash') },
    start() { throw new Error('full-access tests do not execute bash') },
  })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(PermissionPresetService)
  const { agent } = await ctx.agents.create({ sessionId: SessionId('full-access') })
  agent.session.append('turn/start', { turn: 1 })
  return { ctx, agent }
}

/** Queue one waiting input and return its durable identity. */
function queue(agent: Agent, text: string): string {
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  agent.send(message, 'next-turn', false)
  return String(message.id)
}

describe('full access from an approval prompt', () => {
  it('commits the pending input as one receipt and applies the configured preset', async () => {
    const { ctx, agent } = await harness()
    const first = queue(agent, 'first')
    const second = queue(agent, 'second')
    const answer = Promise.withResolvers<ApprovalOutcome>()
    let requestId: string | undefined
    ctx.on('approval/request', (request) => {
      requestId = request.requestId
      expect(request.fullAccess).toBe(true)
      return answer.promise
    })
    const pending = ctx.approval.request({ agent, toolName: 'bash' })
    await vi.waitFor(() => { expect(requestId).toBeDefined() })

    const execution = await ctx.commands.execute(agent, `/full-access ${requestId!}`, [], new AbortController().signal)

    expect(execution?.result).toEqual({ kind: 'success', text: 'full access granted; 2 pending input(s) covered' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'approval/full-access')).toEqual([
      expect.objectContaining({ data: { requestId, targets: [first, second] } }),
    ])
    expect(ctx.permissionPresets.current(agent.session)).toBe('danger-full-access')
    expect(ctx.approval.overrideOf(agent.session)).toBe('never')

    answer.resolve('allowed-once')
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('reuses the committed targets and refuses a settled prompt', async () => {
    const { ctx, agent } = await harness()
    const first = queue(agent, 'first')
    const answer = Promise.withResolvers<ApprovalOutcome>()
    let requestId = ''
    ctx.on('approval/request', (request) => {
      requestId = String(request.requestId)
      return answer.promise
    })
    const pending = ctx.approval.request({ agent, toolName: 'bash' })
    await vi.waitFor(() => { expect(requestId).not.toBe('') })

    await ctx.commands.execute(agent, `/full-access ${requestId}`, [], new AbortController().signal)
    // Input queued after the receipt stays outside the grant.
    queue(agent, 'late')
    await ctx.commands.execute(agent, `/full-access ${requestId}`, [], new AbortController().signal)

    const receipts = agent.session.snapshotEvents().filter(event => event.type === 'approval/full-access')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ data: { targets: [first] } })

    answer.resolve('rejected')
    await expect(pending).resolves.toBe('rejected')
    const stale = await ctx.commands.execute(agent, '/full-access settled-request', [], new AbortController().signal)
    expect(stale?.result).toEqual({
      kind: 'error',
      text: 'this approval prompt is no longer waiting for a decision; grant full access from the live prompt',
    })
  })
})
