/** PreModelRequest/PostModelRequest observe the model-request boundaries. */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { SessionId } from '@deepseek-ai/dsh-session'
import { vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-hooks-'))
  dirs.push(dir)
  return dir
}

function script(dir: string, name: string, marker: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\ncat > "${marker}"\n`)
  chmodSync(path, 0o755)
  return path
}

async function harness(configDir: string): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath: join(configDir, 'hooks.json') })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
  const agent = await ctx.agentLoop.create(SessionId('model-hooks'), { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

describe('model request hook points', () => {
  it('runs PreModelRequest and PostModelRequest beside their durable markers', async () => {
    const dir = tempDir()
    const pre = join(dir, 'pre.json')
    const post = join(dir, 'post.json')
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
      hooks: {
        PreModelRequest: [{ hooks: [{ type: 'command', command: script(dir, 'pre.sh', pre) }] }],
        PostModelRequest: [{ hooks: [{ type: 'command', command: script(dir, 'post.sh', post) }] }],
      },
    }))
    const { ctx, agent } = await harness(dir)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // These points are detached: the turn settles before their shell processes do.
    await vi.waitFor(() => { expect(existsSync(pre) && existsSync(post)).toBe(true) })
    const prePayload = JSON.parse(readFileSync(pre, 'utf8')) as Record<string, unknown>
    const postPayload = JSON.parse(readFileSync(post, 'utf8')) as Record<string, unknown>
    expect(prePayload).toMatchObject({ hook_event_name: 'PreModelRequest', provider: 'mock', model: 'mock' })
    expect(postPayload).toMatchObject({ hook_event_name: 'PostModelRequest', provider: 'mock', model: 'mock' })
    expect(ctx.get('agents')?.get(agent.session.id)).toBeDefined()
  })
})
