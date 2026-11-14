/**
 * Project hook trust: a discovered `.claude/settings.json` runs only while its
 * exact content digest is trusted for the Session's working directory. The
 * tests drive the real loop and real shell hooks, and exercise `/hooks` for
 * status, trust, and revocation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { provideWorkingDirectoryFixture, mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hook-trust-'))
  dirs.push(dir)
  return dir
}

/** Write a project hook config whose PreToolUse command blocks `echo`. */
function projectConfig(project: string): string {
  const script = join(project, 'block.sh')
  writeFileSync(script, "#!/usr/bin/env bash\necho '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"project hook says no\"}}'\n")
  chmodSync(script, 0o755)
  mkdirSync(join(project, '.claude'), { recursive: true })
  const path = join(project, '.claude/settings.json')
  writeFileSync(path, JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: script }] }] },
  }))
  return path
}

interface Bench {
  readonly ctx: Context
  readonly project: string
  /** Run one tool-calling turn and return the model-visible tool result text. */
  run(seed: string): Promise<string>
}

async function harness(options: { storage?: boolean } = {}): Promise<Bench> {
  const ctx = new Context()
  contexts.push(ctx)
  const project = tempDir()
  provideWorkingDirectoryFixture(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(CommandRuntime)
  if (options.storage !== false) {
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
  }
  // The process-level config is deployment-owned and unrelated to project trust.
  const processDir = tempDir()
  writeFileSync(join(processDir, 'hooks.json'), JSON.stringify({ hooks: {} }))
  await ctx.plugin(HooksClaude, { configPath: join(processDir, 'hooks.json') })

  let calls = 0
  const turns = Array.from({ length: 12 }, (_, index) => index % 2 === 0
    ? toolCallResponse(`c${String(index)}`, 'echo', { text: 'go' })
    : textResponse('done'))
  ctx.llm.registerAdapter(['mock'], new MockAdapter(turns))
  const results: string[] = []
  ctx.tools.register(defineContentToolFixture({
    name: 'echo', description: 'e', parameters: { text: { type: 'string' } },
    async execute(args) { results.push(String(args.text)); return [{ type: 'text', text: `ran ${String(args.text)}` }] },
  }))

  const run = async (seed: string): Promise<string> => {
    const agent: Agent = await ctx.agentLoop.create(SessionId(`trust-${String(++calls)}`), { provider: 'mock', model: 'mock' }, { cwd: project })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: seed }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const last = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)
    return JSON.stringify(last?.data ?? '')
  }
  return { ctx, project, run }
}

function hooksCommand(ctx: Context, agent: Agent, input: string): Promise<{ kind: string; text?: string } | undefined> {
  return ctx.commands.execute(agent, `/hooks ${input}`, [], new AbortController().signal).then(result => result?.result)
}

describe('project hook trust', () => {
  it('runs project hooks only after trust and stops after revocation', async () => {
    const bench = await harness()
    const config = projectConfig(bench.project)
    expect(config).toContain('.claude')
    const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})

    // Untrusted: the project hook is skipped, so the tool executes.
    expect(await bench.run('before')).toContain('ran go')
    expect(warn.mock.calls.some(([line]) => String(line).includes('/hooks trust'))).toBe(true)

    const agent = await bench.ctx.agentLoop.create(SessionId('trust-owner'), { provider: 'mock', model: 'mock' }, { cwd: bench.project })
    expect((await hooksCommand(bench.ctx, agent, 'status'))?.text).toContain('not trusted')
    expect((await hooksCommand(bench.ctx, agent, 'trust'))?.text).toContain('Trusted project hooks')

    // Trusted: the project hook denies the call.
    const blocked = await bench.run('after')
    expect(blocked).toContain('project hook says no')
    expect(blocked).not.toContain('ran go')

    expect((await hooksCommand(bench.ctx, agent, 'revoke'))?.text).toContain('Revoked project hook trust')
    expect(await bench.run('revoked')).toContain('ran go')
  })

  it('suspends trusted hooks when the configuration content changes', async () => {
    const bench = await harness()
    const config = projectConfig(bench.project)
    const agent = await bench.ctx.agentLoop.create(SessionId('trust-editor'), { provider: 'mock', model: 'mock' }, { cwd: bench.project })
    await hooksCommand(bench.ctx, agent, 'trust')
    expect(await bench.run('trusted')).toContain('project hook says no')

    // A whitespace-only edit changes the approved bytes.
    writeFileSync(config, `${readFileSync(config, 'utf8')}\n`)
    expect((await hooksCommand(bench.ctx, agent, 'status'))?.text).toContain('not trusted')
    expect(await bench.run('edited')).toContain('ran go')
  })

  it('reports missing configuration and requires storage for trust', async () => {
    const bench = await harness({ storage: false })
    const agent = await bench.ctx.agentLoop.create(SessionId('trust-missing'), { provider: 'mock', model: 'mock' }, { cwd: bench.project })
    expect((await hooksCommand(bench.ctx, agent, 'status'))?.text).toContain('No hook configuration')
    expect((await hooksCommand(bench.ctx, agent, 'trust'))?.text).toContain('requires a mounted storage domain')
    expect((await hooksCommand(bench.ctx, agent, 'bogus'))?.text).toContain('Usage: /hooks')
  })
})
