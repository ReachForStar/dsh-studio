import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as MemoryNotes from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function boot(maxWriteChars = 4000) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-write-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'MEMORY.md'), 'existing\n')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  provideWorkingDirectoryFixture(ctx, root)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  MemoryNotes.apply(ctx, { maxWriteChars })
  const session = ctx.sessions.create(SessionId('memory-write'), { meta: { cwd: root } })
  session.append('turn/start', { turn: 1 })
  const agent = { session } as never
  let call = 0
  async function write(scope: string, text: string) {
    const callId = ToolCallId(`memory-write-${++call}`)
    const serialized = JSON.stringify({ scope, text })
    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'memory_write', arguments: serialized }],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
    }, { surfaceOp: 'append' })
    const source = session.append('tool/call', { turn: 1, step: 1, callId, name: 'memory_write', arguments: serialized })
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal, callId, name: 'memory_write', arguments: { scope, text }, agent,
    })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    return result
  }
  return { root, ctx, write, memory: () => readFile(join(root, 'MEMORY.md'), 'utf8') }
}

describe('memory_write', () => {
  it('appends bullets without interleaving concurrent writes', async () => {
    const t = await boot()
    const results = await Promise.all([t.write('project', 'first fact'), t.write('project', 'second fact')])
    expect(results.every(result => !result.isError)).toBe(true)
    expect(await t.memory()).toBe('existing\n- first fact\n- second fact\n')
  })

  it('creates the note with a header when it does not exist', async () => {
    const t = await boot()
    await writeFile(join(t.root, 'MEMORY.md'), '')
    expect((await t.write('project', 'fresh fact')).isError).toBe(false)
    expect(await t.memory()).toBe('# Memory\n\n- fresh fact\n')
  })

  it('rejects credential-like text and oversize notes without writing', async () => {
    const t = await boot(8)
    const secret = await t.write('project', 'token = sk-abcdefghijklmnopqrstuvwxyz')
    expect(secret.isError).toBe(true)
    expect(await t.memory()).toBe('existing\n')

    const long = await t.write('project', 'too long to store')
    expect(long.isError).toBe(true)
    expect(await t.memory()).toBe('existing\n')
  })
})
