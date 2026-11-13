import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRule } from '@deepseek-ai/dsh-user-approval'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface RegisteredCommand {
  readonly name: string
  handler: (invocation: { agent: Agent; rawInput: string }) => Promise<{ kind: string; text?: string }>
}

/** Mount the approval service over an in-memory storage domain and a command registry stub. */
async function harness(options: { storage?: boolean; cwd?: string | null } = {}): Promise<{
  readonly ctx: Context
  readonly agent: Agent
  readonly commands: Map<string, RegisteredCommand>
  readonly storage: MemoryMediaPool
  readonly serviceFiber: { dispose(): Promise<void> }
}> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const commands = new Map<string, RegisteredCommand>()
  ctx.provide('commands', {
    register: (definition: RegisteredCommand) => {
      commands.set(definition.name, definition)
      return () => { commands.delete(definition.name) }
    },
  } as never)
  const pool = new MemoryMediaPool()
  if (options.storage !== false) {
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
  }
  const serviceFiber = await ctx.plugin(ApprovalService)
  const session = ctx.sessions.create(SessionId('rules'), {
    meta: { ...options.cwd === null ? {} : { cwd: options.cwd ?? '/work' }, createdAt: 1 },
  })
  session.append('turn/start', { turn: 1 })
  return { ctx, agent: { session } as Agent, commands, storage: pool, serviceFiber }
}

const writeRule: ApprovalRule = { action: 'write', resource: 'notes/**', effect: 'allow' }

describe('project approval rules', () => {
  it('persists rules per project and lets a stored allow rule grant without an answerer', async () => {
    const { ctx, agent } = await harness()
    await expect(ctx.approval.addProjectRule('/work', writeRule)).resolves.toEqual([writeRule])
    expect(ctx.approval.projectRulesFor('/work')).toEqual([writeRule])
    expect(ctx.approval.projectRulesFor('/other')).toEqual([])
    const answerer = vi.fn(() => Promise.resolve<ApprovalOutcome>('rejected'))
    ctx.on('approval/request', answerer)

    await expect(ctx.approval.request({
      agent, toolName: 'write', action: 'write', resources: ['notes/a.txt'],
    })).resolves.toBe('allowed-once')
    expect(answerer).not.toHaveBeenCalled()
  })

  it('survives a service restart over the same storage medium', async () => {
    const { ctx, serviceFiber } = await harness()
    await ctx.approval.addProjectRule('/work', writeRule)
    await serviceFiber.dispose()
    await ctx.plugin(ApprovalService)
    expect(ctx.approval.projectRulesFor('/work')).toEqual([writeRule])
  })

  it('removes a rule by position and deletes the record with the last rule', async () => {
    const { ctx } = await harness()
    const deny: ApprovalRule = { action: 'bash', resource: 'rm *', effect: 'deny' }
    await ctx.approval.addProjectRule('/work', writeRule)
    await ctx.approval.addProjectRule('/work', deny)
    await expect(ctx.approval.removeProjectRule('/work', 0)).resolves.toEqual(writeRule)
    expect(ctx.approval.projectRulesFor('/work')).toEqual([deny])
    await expect(ctx.approval.removeProjectRule('/work', 0)).resolves.toEqual(deny)
    expect(ctx.approval.projectRulesFor('/work')).toEqual([])
    await expect(ctx.approval.removeProjectRule('/work', 0)).resolves.toBeUndefined()
  })

  it('refuses invalid rules and a deployment without storage', async () => {
    const { ctx } = await harness({ storage: false })
    await expect(ctx.approval.addProjectRule('/work', writeRule)).rejects.toThrow(/storage domain/u)
    expect(ctx.approval.projectRulesFor('/work')).toEqual([])
    const stored = await harness()
    await expect(stored.ctx.approval.addProjectRule('/work', { ...writeRule, action: '', resource: '' }))
      .rejects.toThrow(/non-empty/u)
  })

  it('runs the /allow command grammar against the invoking project', async () => {
    const { ctx, agent, commands } = await harness()
    const allow = commands.get('allow')
    if (allow === undefined) throw new Error('allow command was not registered')
    const run = (rawInput: string): Promise<{ kind: string; text?: string }> =>
      allow.handler({ agent, rawInput })

    expect((await run('list')).text).toContain('No approval rules')
    expect((await run('write notes/guide.txt')).kind).toBe('success')
    expect((await run('write notes/** deny')).kind).toBe('success')
    expect((await run('write build/** allow')).kind).toBe('success')
    expect(ctx.approval.projectRulesFor('/work')).toEqual([
      { action: 'write', resource: 'notes/guide.txt', effect: 'allow' },
      { action: 'write', resource: 'notes/**', effect: 'deny' },
      { action: 'write', resource: 'build/**', effect: 'allow' },
    ])
    expect((await run('list')).text).toContain('1. allow write notes/guide.txt')
    expect((await run('remove 1')).kind).toBe('success')
    expect((await run('remove 9')).kind).toBe('error')
    expect(ctx.approval.projectRulesFor('/work')).toEqual([
      { action: 'write', resource: 'notes/**', effect: 'deny' },
      { action: 'write', resource: 'build/**', effect: 'allow' },
    ])
    expect((await run('')).kind).toBe('error')
    expect((await run('list now')).kind).toBe('error')
    expect((await run('remove')).kind).toBe('error')
    expect((await run('remove zero')).kind).toBe('error')
    expect((await run('write')).kind).toBe('error')
    expect((await run('write notes/** maybe')).text).toContain('notes/** maybe')
  })

  it('reports a session without a project directory', async () => {
    const { ctx, agent, commands } = await harness({ cwd: null })
    const allow = commands.get('allow')
    if (allow === undefined) throw new Error('allow command was not registered')
    const result = await allow.handler({ agent, rawInput: 'list' })
    expect(result.kind).toBe('error')
    expect(ctx.approval.projectRulesFor(undefined)).toEqual([])
  })
})
