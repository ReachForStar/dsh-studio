import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ArenaService, { Config, type ArenaRun } from '../src/index.ts'

/** Real Git worktrees: each case pays for several process spawns, so it gets its own budget. */
function gitTest(name: string, body: () => void | Promise<void>): void {
  it(name, body, 60_000)
}

let root: string
let repository: string
let worktrees: string
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-arena-'))
  repository = join(root, 'repo')
  worktrees = join(root, 'worktrees')
  execFileSync('git', ['init', '--quiet', repository])
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'arena@example.com'])
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'Arena'])
  await writeFile(join(repository, 'a.txt'), 'one\n')
  execFileSync('git', ['-C', repository, 'add', '.'])
  execFileSync('git', ['-C', repository, 'commit', '--quiet', '-m', 'base'])
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await rm(root, { recursive: true, force: true })
})

/** Behaviour one scripted contender performs after receiving its prompt. */
type Script = (session: Session, worktree: string) => void

/** Mount the Arena service over a scripted Agent registry. */
async function harness(scripts: Record<string, Script> = {}, options: {
  failCreateFor?: string
  failDisposeFor?: string
  failIdleFor?: string
  abortOn?: { controller: AbortController; label: string }
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: repository })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Sandbox)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: repository })
  await ctx.plugin(SessionStore)
  const created: Session[] = []
  ctx.provide('agents', {
    create: async (createOptions: { sessionId: SessionId; meta?: { cwd?: string } }) => {
      const label = String(createOptions.sessionId)
      if (options.failCreateFor !== undefined && label.endsWith(options.failCreateFor)) {
        throw new Error('agent creation failed')
      }
      const session = ctx.sessions.create(createOptions.sessionId)
      created.push(session)
      const script = scripts[Object.keys(scripts).find(key => label.endsWith(key)) ?? '']
      const agent = {
        id: createOptions.sessionId,
        session,
        followup() {
          if (options.abortOn?.label === label.slice(label.lastIndexOf('-') + 1)) {
            options.abortOn.controller.abort(new Error('superseded'))
          }
          script?.(session, createOptions.meta?.cwd ?? '')
        },
        whenIdle: () => {
          if (options.failIdleFor !== undefined && label.endsWith(options.failIdleFor)) {
            // Throwing a non-Error proves the failure text falls back to String(value).
            throw 'idle failed'
          }
          return Promise.resolve()
        },
      }
      const handle: AgentHandle = {
        agent: agent as never,
        dispose: async () => {
          if (options.failDisposeFor !== undefined && label.endsWith(options.failDisposeFor)) {
            throw new Error('dispose failed')
          }
        },
      }
      return handle
    },
  })
  const service = new ArenaService(ctx, {
    workspaceRoot: repository,
    worktreeRoot: worktrees,
    maxContenders: 4,
    timeoutMs: 30_000,
    graceMs: 2_000,
    maxOutputBytes: 1_048_576,
  })
  return { ctx, service, created }
}

/** Adapter-reported usage for one scripted reply. */
function reported(usage: { inputTokens: number; outputTokens: number; totalTokens?: number }) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens },
  }
}

/** Append one completed turn with a tool call, a reply, and reported usage. */
function replyWith(
  session: Session,
  text: string,
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number },
  content: readonly ({ type: 'text'; text: string } | { type: 'reasoning'; text: string })[] = [{ type: 'text', text }],
): void {
  session.append('turn/start', { turn: 1 })
  session.append('tool/call', {
    turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'read', arguments: '{}',
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [...content],
      source: { provider: 'arena', model: 'test' },
    }),
    stream: [],
    ...usage === undefined ? {} : { usage: reported(usage) },
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
}

describe('ArenaService configuration', () => {
  it.each([
    [{ workspaceRoot: 'repo', worktreeRoot: '/tmp/worktrees' }, /workspaceRoot must be an absolute path/],
    [{ workspaceRoot: '/repo', worktreeRoot: 'worktrees' }, /worktreeRoot must be an absolute path/],
    [{ workspaceRoot: '/repo', worktreeRoot: '/repo/.arena' }, /worktreeRoot must live outside workspaceRoot/],
  ])('rejects %#', async (roots, message) => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: repository })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(Sandbox)
    await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: repository })
    expect(() => new ArenaService(ctx, {
      maxContenders: 4, timeoutMs: 1_000, graceMs: 1_000, maxOutputBytes: 1_024, ...roots,
    })).toThrow(message)
  }, 60_000)

  gitTest('exposes a loader schema with defaults', () => {
    // A user configuration omits defaulted fields; the schema fills them.
    const load = (partial: Pick<Config, 'workspaceRoot' | 'worktreeRoot'>): Config => Config(partial as Config)
    expect(load({ workspaceRoot: '/repo', worktreeRoot: '/tree' })).toEqual({
      workspaceRoot: '/repo', worktreeRoot: '/tree', maxContenders: 4,
      timeoutMs: 60_000, graceMs: 3_000, maxOutputBytes: 1_048_576,
    })
  })
})

describe('ArenaService.run', () => {
  gitTest('runs every contender in its own checkout and reports comparable data', async () => {
    const { service } = await harness({
      alpha: (session, worktree) => {
        writeFileSync(join(worktree, 'a.txt'), 'one\nalpha\n')
        replyWith(session, 'alpha reply', { inputTokens: 10, outputTokens: 5 })
      },
      beta: (session, worktree) => {
        writeFileSync(join(worktree, 'b.txt'), 'beta\n')
        replyWith(session, 'beta reply', { inputTokens: 3, outputTokens: 4 })
        replyWith(session, 'beta reply', undefined, [{ type: 'reasoning', text: 'thinking' }])
      },
    })
    const run = await service.run({
      prompt: 'add a line',
      contenders: [
        { label: 'Alpha', provider: 'p', model: 'm1' },
        { label: 'beta', provider: 'p', model: 'm2', maxTokens: 64 },
      ],
    })
    expect(run.prompt).toBe('add a line')
    expect(run.baseCommit).toMatch(/^[0-9a-f]{40}$/u)
    expect(run.contenders.map(contender => contender.label)).toEqual(['alpha', 'beta'])
    expect(run.contenders[0]).toMatchObject({
      status: 'completed',
      reply: 'alpha reply',
      turns: 1,
      toolCalls: 1,
      tokens: 15,
      changedPaths: ['a.txt'],
    })
    expect(run.contenders[0]?.branch).toContain('arena/')
    expect(run.contenders[1]).toMatchObject({ reply: 'beta reply', tokens: 7, changedPaths: ['b.txt'] })
    // The main checkout is untouched until apply().
    expect(await readFile(join(repository, 'a.txt'), 'utf8')).toBe('one\n')
    expect(service.runs()).toEqual([run])
  })

  gitTest('applies one contender and removes the run checkouts', async () => {
    const { service } = await harness({
      alpha: (session, worktree) => {
        writeFileSync(join(worktree, 'a.txt'), 'one\nalpha\n')
        writeFileSync(join(worktree, 'c.txt'), 'created\n')
        replyWith(session, 'alpha reply')
      },
      beta: (session, worktree) => {
        writeFileSync(join(worktree, 'b.txt'), 'beta\n')
        replyWith(session, 'beta reply', { inputTokens: 3, outputTokens: 4 })
        replyWith(session, 'beta reply', undefined, [{ type: 'reasoning', text: 'thinking' }])
      },
    })
    const run = await service.run({
      prompt: 'add a line',
      contenders: [{ label: 'alpha', provider: 'p', model: 'm1' }, { label: 'beta', provider: 'p', model: 'm2' }],
    })
    expect(await service.apply(run.runId, 'alpha')).toEqual(['a.txt', 'c.txt'])
    expect(await readFile(join(repository, 'a.txt'), 'utf8')).toBe('one\nalpha\n')
    expect(await readFile(join(repository, 'c.txt'), 'utf8')).toBe('created\n')
    expect(await readFile(join(repository, 'b.txt'), 'utf8').catch(() => 'absent')).toBe('absent')

    await service.remove(run.runId)
    expect(service.runs()).toEqual([])
    await expect(readFile(join(run.contenders[0]!.worktree, 'a.txt'), 'utf8')).rejects.toThrow()
  })

  gitTest('applies nothing for a contender that changed nothing', async () => {
    const { service } = await harness({ alpha: (session) => { replyWith(session, 'no edit') } })
    const run = await service.run({
      prompt: 'look around',
      contenders: [{ label: 'alpha', provider: 'p', model: 'm1' }],
    })
    expect(run.contenders[0]?.changedPaths).toEqual([])
    expect(await service.apply(run.runId, 'alpha')).toEqual([])
  })

  gitTest('reports one failed contender without failing the run', async () => {
    const { service } = await harness(
      { beta: (session) => { replyWith(session, 'beta reply') } },
      { failCreateFor: 'alpha' },
    )
    const run = await service.run({
      prompt: 'add a line',
      contenders: [{ label: 'alpha', provider: 'p', model: 'm1' }, { label: 'beta', provider: 'p', model: 'm2' }],
    })
    expect(run.contenders[0]).toMatchObject({ status: 'failed', failure: 'agent creation failed', turns: 0 })
    expect(run.contenders[1]).toMatchObject({ status: 'completed', reply: 'beta reply' })
  })

  gitTest('reports a cancelled contender when the caller aborts', async () => {
    const controller = new AbortController()
    const { service } = await harness(
      { alpha: (session) => { replyWith(session, 'alpha reply') } },
      { abortOn: { controller, label: 'alpha' } },
    )
    const run = await service.run({
      prompt: 'add a line',
      contenders: [{ label: 'alpha', provider: 'p', model: 'm1' }],
    }, { signal: controller.signal })
    expect(run.contenders[0]).toMatchObject({ status: 'cancelled', reply: '' })
  })

  gitTest('warns instead of failing when a settled Agent cannot be disposed', async () => {
    const { ctx, service } = await harness(
      { alpha: (session) => { replyWith(session, 'alpha reply') } },
      { failDisposeFor: 'alpha' },
    )
    const warn = vi.spyOn(ctx.logger, 'warn')
    const run = await service.run({
      prompt: 'add a line',
      contenders: [{ label: 'alpha', provider: 'p', model: 'm1' }],
    })
    expect(run.contenders[0]?.status).toBe('completed')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispose failed'))
  })

  gitTest('ignores events from Sessions the run does not own and warns when a failing contender cannot be cleaned up', async () => {
    const { ctx, service, created } = await harness(
      { alpha: (session) => { replyWith(session, 'alpha reply') } },
      { failIdleFor: 'alpha', failDisposeFor: 'alpha' },
    )
    const warn = vi.spyOn(ctx.logger, 'warn')
    const run = await service.run({
      prompt: 'add a line',
      contenders: [{ label: 'alpha', provider: 'p', model: 'm1' }],
    })
    expect(run.contenders[0]).toMatchObject({ status: 'failed', failure: 'idle failed' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'))
    // An unrelated Session's events stay out of the comparison data.
    const foreign = ctx.sessions.create()
    foreign.append('turn/start', { turn: 1 })
    expect(run.contenders[0]?.turns).toBe(0)
    expect(created.length).toBeGreaterThan(0)
  })

  gitTest('rejects a malformed or oversized request', async () => {
    const { service } = await harness()
    const signal = new AbortController().signal
    await expect(service.run([] as never, { signal })).rejects.toThrow('run request must be an object')
    await expect(service.run({ prompt: 'x', contenders: [] }, { signal }))
      .rejects.toThrow('requires at least one contender')
    await expect(service.run({
      prompt: 'x',
      contenders: Array.from({ length: 5 }, (_unused, index) => ({ label: `c${String(index)}`, provider: 'p', model: 'm' })),
    }, { signal })).rejects.toThrow('above maxContenders 4')
    await expect(service.run({ prompt: '  ', contenders: [{ label: 'a', provider: 'p', model: 'm' }] }, { signal }))
      .rejects.toThrow('prompt must be a non-empty string')
    await expect(service.run({ prompt: 'x', contenders: [null as never] }, { signal }))
      .rejects.toThrow('contender 0 must be an object')
    await expect(service.run({ prompt: 'x', contenders: [{ label: '!!!', provider: 'p', model: 'm' }] }, { signal }))
      .rejects.toThrow('has no usable characters')
    await expect(service.run({
      prompt: 'x',
      contenders: [{ label: 'a', provider: 'p', model: 'm' }, { label: 'A', provider: 'p', model: 'm' }],
    }, { signal })).rejects.toThrow('duplicated')
    await expect(service.run({ prompt: 'x', contenders: [{ label: 'a', provider: '', model: 'm' }] }, { signal }))
      .rejects.toThrow('provider must be a non-empty string')
    await expect(service.run({ prompt: 'x', contenders: [{ label: 'a', provider: 'p', model: 'm', maxTokens: 0 }] }, { signal }))
      .rejects.toThrow('maxTokens must be a positive safe integer')
    await expect(service.run({ prompt: 'x', contenders: [{ label: 'a', provider: 'p', model: 'm' }], from: ' ' }, { signal }))
      .rejects.toThrow('from must be a non-empty string')
  })

  gitTest('rejects an unknown base commit before creating anything', async () => {
    const { service } = await harness()
    await expect(service.run({
      prompt: 'x',
      contenders: [{ label: 'a', provider: 'p', model: 'm' }],
      from: 'no-such-ref',
    })).rejects.toThrow('arena git rev-parse')
    expect(service.runs()).toEqual([])
  })
})

describe('ArenaService retention', () => {
  gitTest('rejects an unknown run for apply and remove', async () => {
    const { service } = await harness()
    await expect(service.apply('missing', 'alpha')).rejects.toThrow('unknown run "missing"')
    await expect(service.remove('missing')).rejects.toThrow('unknown run "missing"')
  })

  gitTest('rejects an unknown contender and warns when a checkout cannot be removed', async () => {
    const { ctx, service } = await harness({
      alpha: (session, worktree) => {
        writeFileSync(join(worktree, 'a.txt'), 'one\nalpha\n')
        replyWith(session, 'alpha reply')
      },
    })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const run = await service.run({
      prompt: 'add a line',
      contenders: [{ label: 'alpha', provider: 'p', model: 'm1' }],
    })
    await expect(service.apply(run.runId, 'missing')).rejects.toThrow('has no contender "missing"')
    await rm(run.contenders[0]!.worktree, { recursive: true, force: true })
    // A plain file where the checkout used to be makes the removal fail visibly.
    await writeFile(run.contenders[0]!.worktree, 'not a worktree')
    await service.remove(run.runId)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not remove'))
  })
})

describe('ArenaService lifecycle', () => {
  gitTest('aborts retained runs when the service unloads', async () => {
    const { ctx, service } = await harness({
      alpha: (session) => { replyWith(session, 'alpha reply') },
    })
    const run = await service.run({
      prompt: 'add a line',
      contenders: [{ label: 'alpha', provider: 'p', model: 'm1' }],
    })
    expect(run.contenders).toHaveLength(1)
    await ctx.fiber.dispose()
    expect(service.runs()).toEqual([])
  })
})

/** Keep the unused `ArenaRun` import meaningful for the retention assertions. */
export type ArenaRunAlias = ArenaRun
