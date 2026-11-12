import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsTargetKey, FsVersion, type FsInfo, type FsTarget } from '@deepseek-ai/dsh-fs'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
  provideWorkingDirectoryFixture,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '../src/config.ts'
import {
  boundMemoryContent,
  discoverMemoryFiles,
  findProjectRoot,
  loadMemoryFiles,
} from '../src/files.ts'
import {
  apply as memoryNotesApply,
  applyPreStepMemory,
  isMemoryNoteMessage,
  loadMemoryNote,
  renderMemoryNote,
} from '../src/index.ts'
import { resolveConfig as resolveMemoryConfig } from '../src/config.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Content-addressed provider with a single workspace root and optional user memory directory. */
class StubFileSystem extends FileSystem {
  files = new Map<string, string>()
  missing = new Set<string>()
  cwd = '/repo'

  override async resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget> {
    const base = opts?.cwd ?? this.cwd
    const joined = path.startsWith('/') ? path : join(base, path)
    return { targetKey: FsTargetKey(joined), displayPath: joined }
  }

  override processPath(target: FsTarget): string { return String(target.targetKey) }

  override fileUrl(target: FsTarget): string { return `file://${target.targetKey}` }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return String(child.targetKey).startsWith(String(parent.targetKey))
  }

  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const key = String(target.targetKey)
    if (this.missing.has(key)) return undefined
    const content = this.files.get(key)
    if (content === undefined) return undefined
    return { version: FsVersion(`v:${content}`), type: 'file' }
  }

  override async lstat(path: string, opts?: { cwd?: string }): Promise<FsInfo | undefined> {
    return this.stat(await this.resolve(path, opts))
  }

  override async readText(target: FsTarget): Promise<string> {
    return this.files.get(String(target.targetKey)) ?? ''
  }

  override async streamText(_target: FsTarget): Promise<AsyncIterable<string>> {
    return (async function* () { yield await Promise.resolve('') })()
  }

  override async readBytes(_t: FsTarget, _s: AbortSignal | undefined, _m: number): Promise<Uint8Array> { throw new Error('unused') }
  override async readByteRange(_t: FsTarget, _r: { offset: number; length: number }, _s?: AbortSignal): Promise<Uint8Array> { throw new Error('unused') }
  override async listDir(_t: FsTarget, _s?: AbortSignal): Promise<never> { throw new Error('unused') }
  override async writeText(): Promise<never> { throw new Error('unused') }
  override async editText(): Promise<never> { throw new Error('unused') }
  override async remove(): Promise<never> { throw new Error('unused') }
  override async patchText(): Promise<never> { throw new Error('unused') }
  override async deleteFile(): Promise<never> { throw new Error('unused') }
  override async moveFile(): Promise<never> { throw new Error('unused') }
}

let dshHome: string
let repo: string
let userMemory: string
const stubCtx = new Context()
const provider = new StubFileSystem(stubCtx)
const isolatedInboxCtx = new Context()
provideWorkingDirectoryFixture(isolatedInboxCtx)
await mountAgentLoopTestDependencies(isolatedInboxCtx)
const isolatedAgentLoop = await mountAgentLoopTestHarness(isolatedInboxCtx)
let nextStubSession = 1

beforeAll(async () => {
  dshHome = await mkdtemp(join(tmpdir(), 'dsh-memory-home-'))
  userMemory = join(dshHome, 'memory')
  repo = await mkdtemp(join(tmpdir(), 'dsh-memory-repo-'))
  await isolatedInboxCtx.plugin(StubFileSystem)
  await isolatedInboxCtx.plugin(MemoryNotesPlugin, {})
})

beforeEach(() => {
  vi.stubEnv('DSH_HOME', dshHome)
  provider.cwd = repo
  provider.files.clear()
  provider.missing.clear()
})

afterAll(async () => {
  await stubCtx.fiber.dispose()
  await isolatedInboxCtx.fiber.dispose()
  await rm(dshHome, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

function sessionAgent(): Promise<Agent> {
  return isolatedAgentLoop.create(
    SessionId(`memory-${String(nextStubSession++)}`),
    {},
    { cwd: repo },
  )
}

async function runPreStep(
  ctx: Context,
  agent: Agent,
  claimed: UserMessage[],
  decisionMessages: UserMessage[] = claimed,
): Promise<{ kind: 'enter'; messages: UserMessage[] }> {
  const signal = new AbortController().signal
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    {
      modelSelection: { provider: 'mock', model: 'mock' },
      messages: claimed,
      turn: 1,
      step: 1,
      signal,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: decisionMessages }),
  )
  if (decision.kind !== 'enter') throw new Error('expected enter')
  return decision
}

describe('config', () => {
  it('applies defaults without input', () => {
    expect(resolveConfig(undefined)).toEqual({
      projectRootMarkers: ['.git'],
      memoryFileNames: ['MEMORY.md'],
      maxChars: 20_000,
    })
  })

  it('keeps explicit values', () => {
    expect(resolveConfig({ memoryFileNames: ['NOTES.md'], maxChars: 10, projectRootMarkers: [] }).maxChars).toBe(10)
  })
})

describe('boundMemoryContent', () => {
  it('keeps short content', () => {
    expect(boundMemoryContent('abc', 10)).toEqual({ content: 'abc', consumed: 3 })
  })

  it('truncates with a marker', () => {
    const result = boundMemoryContent('abcdefgh', 7)
    expect(result.content).toBe('\n…(truncated)')
    expect(result.consumed).toBe(13)
  })
})

describe('findProjectRoot', () => {
  it('returns the cwd when it holds a marker', async () => {
    provider.files.set(join(repo, '.git'), '')
    provider.files.set(join(repo, 'MEMORY.md'), 'note')
    expect(await findProjectRoot(repo, ['.git'], provider, new AbortController().signal)).toBe(repo)
  })

  it('walks upward', async () => {
    const nested = join(repo, 'a', 'b')
    provider.files.set(join(repo, '.git'), '')
    expect(await findProjectRoot(nested, ['.git'], provider, new AbortController().signal)).toBe(repo)
  })

  it('returns undefined above the root', async () => {
    expect(await findProjectRoot(repo, ['.git'], provider, new AbortController().signal)).toBeUndefined()
  })
})

describe('discoverMemoryFiles', () => {
  it('falls back to the basename when the relative path is empty', async () => {
    provider.files.set(join(repo, 'MEMORY.md'), 'project note')
    const found = await discoverMemoryFiles(
      repo, undefined, resolveConfig(undefined), join(repo, 'MEMORY.md'), provider, new AbortController().signal,
    )
    expect(found).toHaveLength(1)
    expect(found[0]!.displayPath).toBe('MEMORY.md')
  })

  it('orders user before project and relativizes the project display path', async () => {
    provider.files.set(join(repo, 'MEMORY.md'), 'project note')
    provider.files.set(join(userMemory, 'MEMORY.md'), 'user note')
    const found = await discoverMemoryFiles(
      repo, userMemory, resolveConfig(undefined), repo, provider, new AbortController().signal,
    )
    expect(found.map(file => file.layer)).toEqual(['user', 'project'])
    expect(found[1]!.displayPath).toBe('MEMORY.md')
  })

  it('skips missing layers', async () => {
    const found = await discoverMemoryFiles(
      repo, undefined, resolveConfig(undefined), repo, provider, new AbortController().signal,
    )
    expect(found).toEqual([])
  })
})

describe('loadMemoryFiles', () => {
  it('applies one shared budget across layers', async () => {
    provider.files.set(join(repo, 'MEMORY.md'), 'x'.repeat(60))
    const discovered = await discoverMemoryFiles(
      repo, undefined, resolveConfig(undefined), repo, provider, new AbortController().signal,
    )
    const loaded = await loadMemoryFiles(discovered, 40, provider, new AbortController().signal)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.content).toContain('…(truncated)')
  })
})

describe('renderMemoryNote', () => {
  it('labels layers and paths', () => {
    const text = renderMemoryNote([
      { layer: 'user', absolutePath: '/u', displayPath: 'MEMORY.md', content: 'u' },
      { layer: 'project', absolutePath: join(repo, 'MEMORY.md'), displayPath: 'MEMORY.md', content: 'p' },
    ])
    expect(text).toContain('--- BEGIN USER MEMORY (MEMORY.md) ---')
    expect(text).toContain('--- BEGIN PROJECT MEMORY (MEMORY.md) ---')
    expect(text).toContain('u')
    expect(text).toContain('p')
  })
})

describe('pre-step integration', () => {
  it('injects the note into the first decision, restates nothing, updates and removes', async () => {
    const ctx = isolatedInboxCtx
    const cfs = ctx.fs as StubFileSystem
    cfs.cwd = repo
    const agent = await sessionAgent()

    // 1. absent -> no note
    let decision = await runPreStep(ctx, agent, [])
    expect(decision.messages.some(isMemoryNoteMessage)).toBe(false)

    // 2. project note appears -> injected once, restate is a no-op
    cfs.files.set(join(repo, '.git'), '')
    cfs.files.set(join(repo, 'MEMORY.md'), 'remember the answer')
    decision = await runPreStep(ctx, agent, [])
    const injected = decision.messages.filter(isMemoryNoteMessage)
    expect(injected).toHaveLength(1)
    expect(textOf(injected[0]!)).toContain('remember the answer')
    const restated = await runPreStep(ctx, agent, [], decision.messages)
    expect(restated.messages).toEqual(decision.messages)

    // 3. edit -> replaced
    cfs.files.set(join(repo, 'MEMORY.md'), 'remember the new answer')
    decision = await runPreStep(ctx, agent, [])
    expect(decision.messages.filter(isMemoryNoteMessage)).toHaveLength(1)
    expect(decision.messages.some(message => isMemoryNoteMessage(message)
      && textOf(message).includes('new answer'))).toBe(true)

    // 4. removed -> the resident note disappears
    cfs.files.delete(join(repo, 'MEMORY.md'))
    decision = await runPreStep(ctx, agent, [], decision.messages)
    expect(decision.messages.some(isMemoryNoteMessage)).toBe(false)
  })
})

describe('loadMemoryFiles edge cases', () => {
  it('skips files without a target and empty content', async () => {
    provider.files.set(join(repo, 'MEMORY.md'), '')
    const target = await provider.resolve('MEMORY.md', { cwd: repo })
    expect(await loadMemoryFiles([
      {
        layer: 'project' as const,
        absolutePath: join(repo, 'MEMORY.md'),
        displayPath: 'MEMORY.md',
        target,
      },
    ], 100, provider, new AbortController().signal)).toEqual([])
    expect(await loadMemoryFiles([
      {
        layer: 'project' as const,
        absolutePath: join(repo, 'MEMORY.md'),
        displayPath: 'MEMORY.md',
      },
    ], 100, provider, new AbortController().signal)).toEqual([])
  })
})

describe('applyPreStepMemory edge cases', () => {
  it('passes through reject decisions unchanged', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx, repo)
    const rejected = { kind: 'reject' as const, reason: 'nope' as const }
    const out = await applyPreStepMemory(
      ctx, await sessionAgent(), rejected, [], resolveMemoryConfig(undefined), new AbortController().signal,
    )
    expect(out).toBe(rejected)
  })

  it('passes through without an fs provider', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx, repo)
    const decision = { kind: 'enter' as const, messages: [] as UserMessage[] }
    const out = await applyPreStepMemory(
      ctx, await sessionAgent(), decision, [], resolveMemoryConfig(undefined), new AbortController().signal,
    )
    expect(out).toBe(decision)
  })

  it('restates an identical note as a no-op', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx, repo)
    await ctx.plugin(StubFileSystem)
    const cfs = ctx.fs as StubFileSystem
    cfs.cwd = repo
    cfs.files.set(join(repo, '.git'), '')
    cfs.files.set(join(repo, 'MEMORY.md'), 'note')
    const agent = await sessionAgent()
    const config = resolveMemoryConfig(undefined)
    const signal = new AbortController().signal
    const first = await applyPreStepMemory(
      ctx, agent, { kind: 'enter', messages: [] }, [], config, signal,
    )
    const restated = await applyPreStepMemory(ctx, agent, first, [], config, signal)
    expect(restated).toBe(first)
  })

  it('folds the note after the claimed batch', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx, repo)
    await ctx.plugin(StubFileSystem)
    const cfs = ctx.fs as StubFileSystem
    cfs.cwd = repo
    cfs.files.set(join(repo, '.git'), '')
    cfs.files.set(join(repo, 'MEMORY.md'), 'note')
    const agent = await sessionAgent()
    const prompt = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    const out = await applyPreStepMemory(
      ctx, agent, { kind: 'enter', messages: [prompt] }, [prompt],
      resolveMemoryConfig(undefined), new AbortController().signal,
    )
    if (out.kind !== 'enter') throw new Error('the note must keep the step admitted')
    expect(out.messages.map(message => (message.source as { kind: string }).kind)).toEqual(['user', 'memory-notes'])
  })
})

describe('loadMemoryNote', () => {
  it('returns undefined without files and a message with a project note', async () => {
    expect(await loadMemoryNote(provider, repo, resolveConfig(undefined), new AbortController().signal))
      .toBeUndefined()
    provider.files.set(join(repo, '.git'), '')
    provider.files.set(join(repo, 'MEMORY.md'), 'note')
    const note = await loadMemoryNote(provider, repo, resolveConfig(undefined), new AbortController().signal)
    expect(note).toBeDefined()
    expect(note!.source.kind).toBe('memory-notes')
  })

  it('disables injection at zero budget', async () => {
    provider.files.set(join(repo, 'MEMORY.md'), 'note')
    const config = resolveConfig({ maxChars: 0 })
    expect(await loadMemoryNote(provider, repo, config, new AbortController().signal)).toBeUndefined()
  })

  it('prefers the same createUserMessage shape', () => {
    const note = createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'memory-notes' } })
    expect(note.source.kind).toBe('memory-notes')
  })
})

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

const MemoryNotesPlugin = {
  name: 'memory-notes',
  inject: ['agents', 'workingDirectory'],
  apply: memoryNotesApply,
}
