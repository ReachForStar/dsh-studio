import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { Config, executeCheckpoint, GitCheckpointService } from '../src/index.ts'

interface RunLog {
  readonly args: readonly string[]
  readonly workdir: string | undefined
}

interface Answer {
  exitCode: number | null
  stdout?: string
  stderr?: string
}

function stubShell(answers: ReadonlyMap<string, Answer>, log: RunLog[]) {
  return {
    resolve: (request: { command: string; args: string[]; workdir?: string; timeoutMs?: number }) => ({ ...request }),
    execute: async (spec: { command: string; workdir?: string }) => {
      log.push({ args: spec.command.split(' '), workdir: spec.workdir })
      const answer = answers.get(spec.command) ?? { exitCode: 1, stderr: `unexpected command: ${spec.command}` }
      return {
        result: async () => ({
          exitCode: answer.exitCode,
          stdout: { text: answer.stdout ?? '', truncated: false },
          stderr: { text: answer.stderr ?? '', truncated: false },
        }),
      }
    },
  }
}

async function harness(answers: ReadonlyMap<string, Answer> = new Map(), log: RunLog[] = []) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.provide('shell', stubShell(answers, log))
  const config = Config({ timeoutMs: 10_000 })
  const service = new GitCheckpointService(ctx)
  const session = ctx.sessions.create(brandString<SessionId>('git-checkpoint-test'), { meta: { cwd: process.cwd() } })
  return { ctx, service, session, config, log }
}

function invocationOf(session: Session, rawInput: string): CommandInvocation {
  return { agent: { session }, rawInput } as never
}

describe('GitCheckpointService', () => {
  it('captures a stash reference and remembers it per session', async () => {
    const answers = new Map([
      ['git rev-parse --is-inside-work-tree', { exitCode: 0, stdout: 'true' }],
      ['git stash create', { exitCode: 0, stdout: 'abc123 refs/stash' }],
    ])
    const log: RunLog[] = []
    const { ctx, service, session } = await harness(answers, log)
    const logBefore = log.length
    const ref = await service.capture(session, 1_000)
    expect(log.length).toBe(logBefore + 2)
    expect(ref).toBe('abc123 refs/stash')
    expect(service.lastOf(session)).toBe('abc123 refs/stash')
    await ctx.fiber.dispose()
  })

  it('reports no checkpoint when the worktree has no changes', async () => {
    const answers = new Map([
      ['git rev-parse --is-inside-work-tree', { exitCode: 0, stdout: 'true' }],
      ['git stash create', { exitCode: 0, stdout: '\n' }],
    ])
    const { ctx, service, session } = await harness(answers)
    await expect(service.capture(session, 1_000)).resolves.toBeUndefined()
    expect(service.lastOf(session)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects a directory outside a Git work tree', async () => {
    const answers = new Map([
      ['git rev-parse --is-inside-work-tree', { exitCode: 0, stdout: 'false' }],
    ])
    const { ctx, service, session } = await harness(answers)
    await expect(service.capture(session, 1_000)).rejects.toThrow('inside a Git work tree')
    await ctx.fiber.dispose()
  })

  it('restores through git stash apply and clears the reference', async () => {
    const answers = new Map([
      ['git rev-parse --is-inside-work-tree', { exitCode: 0, stdout: 'true' }],
      ['git stash apply def456', { exitCode: 0 }],
    ])
    const log: RunLog[] = []
    const { ctx, service, session } = await harness(answers, log)
    await service.restore(session, 'def456', 1_000)
    expect(log.at(-1)?.args).toEqual(['git', 'stash', 'apply', 'def456'])
    service.clear(session)
    expect(service.lastOf(session)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('executeCheckpoint', () => {
  it('captures, restores, and clears through the command grammar', async () => {
    const answers = new Map([
      ['git rev-parse --is-inside-work-tree', { exitCode: 0, stdout: 'true' }],
      ['git stash create', { exitCode: 0, stdout: 'abc123' }],
      ['git stash apply abc123', { exitCode: 0 }],
    ])
    const { ctx, service, session, config } = await harness(answers)
    const captured = await executeCheckpoint(service, invocationOf(session, ''), config)
    expect(captured.kind).toBe('success')
    expect(captured.text).toContain('abc123')
    const restored = await executeCheckpoint(service, invocationOf(session, 'restore'), config)
    expect(restored.kind).toBe('success')
    const cleared = await executeCheckpoint(service, invocationOf(session, 'clear'), config)
    expect(cleared.kind).toBe('success')
    await ctx.fiber.dispose()
  })

  it('rejects an unknown sub-command', async () => {
    const { ctx, service, session, config } = await harness()
    const result = await executeCheckpoint(service, invocationOf(session, 'nonsense'), config)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Usage: /checkpoint')
    await ctx.fiber.dispose()
  })
})
