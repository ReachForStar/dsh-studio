import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as pi from '../src/index.ts'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const piBinDir = join(packageRoot, 'node_modules', '.bin')
const piPackage = JSON.parse(readFileSync(
  join(packageRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'),
  'utf8',
)) as { version: string }

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

interface RealHarness {
  readonly ctx: Context
  readonly handles: SubprocessHandle[]
  readonly parent: Agent
  readonly agentDir: string
}

async function realHarness(): Promise<RealHarness> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-real-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const agentDir = join(root, 'pi-agent')
  const sessionDir = join(root, 'pi-sessions')
  mkdirSync(workspace)
  mkdirSync(agentDir)
  mkdirSync(sessionDir)
  const env = {
    // The fixed `pi` command resolves from PATH; the package-local bin shim
    // supplies the pinned fixture version.
    PATH: `${piBinDir}${delimiter}${process.env.PATH ?? ''}`,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const handles: SubprocessHandle[] = []
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = spawn(spec)
    handles.push(handle)
    return handle
  })
  await ctx.plugin(pi, {
    env,
    agentDir,
    sessionDir,
    disposeEofGraceMs: 2_000,
    disposeGraceMs: 2_000,
  })
  const parent = {
    id: 'pi-real-parent',
    session: { header: { cwd: workspace } },
  } as unknown as Agent
  return { ctx, handles, parent, agentDir }
}

async function expectQuiescent(handles: readonly SubprocessHandle[]): Promise<void> {
  expect(handles.length).toBeGreaterThan(0)
  for (const handle of handles) {
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome).toHaveProperty('exitCode')
    expect(outcome).toHaveProperty('signal')
  }
}

describe('real @earendil-works/pi-coding-agent 0.84.2 product', () => {
  it('starts the real Pi RPC server, redirects its dirs, and maps the keyless prompt to error', async () => {
    const { ctx, handles, parent, agentDir } = await realHarness()
    expect(piPackage.version).toBe('0.84.2')

    const run = await ctx.subagents.start('pi', {
      prompt: [{ type: 'text', text: 'Return OK.' }],
      parent,
      signal: new AbortController().signal,
    })
    // No provider is configured in this keyless fixture, so Pi's prompt
    // preflight fails fast; the seam maps that to `error` without a hang.
    await expect(run.result).resolves.toMatchObject({
      output: [],
      stopReason: 'error',
    })
    await run.dispose()
    await run.dispose()
    await expectQuiescent(handles)

    // The redirected agent directory proves Pi ran with the provider-owned
    // PI_CODING_AGENT_DIR (its auth/model state lands there), not the user's
    // native home; Pi removes its session file on clean EOF shutdown.
    expect(readdirSync(agentDir).length).toBeGreaterThan(0)
  }, 60_000)
})
