import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function expectQuiescent(handles: readonly SubprocessHandle[]): Promise<void> {
  expect(handles.length).toBeGreaterThan(0)
  for (const handle of handles) {
    await expect(handle.waitForExit()).resolves.toBe(true)
    await expect(handle.done).resolves.toHaveProperty('exitCode')
  }
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)(
  'Pi provider with real DeepSeek API',
  () => {
    it('returns one unique nonce through the production provider and real Pi', async () => {
      const apiKey = process.env.DEEPSEEK_API_KEY
      if (apiKey === undefined) throw new Error('e2e ran without DEEPSEEK_API_KEY')
      const root = mkdtempSync(join(tmpdir(), 'dsh-pi-deepseek-e2e-'))
      roots.push(root)
      const workspace = join(root, 'workspace')
      const agentDir = join(root, 'pi-agent')
      const sessionDir = join(root, 'pi-sessions')
      mkdirSync(workspace)
      mkdirSync(agentDir)
      mkdirSync(sessionDir)
      const nonce = `DSH_PI_DEEPSEEK_${randomUUID()}`
      const env = {
        DEEPSEEK_API_KEY: apiKey,
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
      expect(piPackage.version).toBe('0.84.2')
      await ctx.plugin(pi, {
        env,
        agentDir,
        sessionDir,
        // `args` replaces the default `['--mode', 'rpc']`, so the override
        // restates it and pins the pi-ai catalog's deepseek provider; its
        // default catalog model for that provider serves the turn.
        args: ['--mode', 'rpc', '--provider', 'deepseek'],
        disposeEofGraceMs: 2_000,
        disposeGraceMs: 2_000,
      })
      const parent = {
        id: 'pi-deepseek-e2e-parent',
        session: { header: { cwd: workspace } },
      } as unknown as Agent
      const run = await ctx.subagents.start('pi', {
        prompt: [{
          type: 'text',
          text: `Reply with exactly ${nonce} and nothing else. Do not use tools.`,
        }],
        parent,
        signal: new AbortController().signal,
      })
      const result = await run.result
      await run.dispose()

      expect(result.stopReason).toBe('completed')
      const text = result.output
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim()
      expect(text).toBe(nonce)
      await expectQuiescent(handles)
    }, 180_000)
  },
)
