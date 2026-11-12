import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolBatchResult } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as Speculation from '../src/runner.ts'
import {
  executePlan,
  matchesPrediction,
  parsePlan,
  renderPlanInput,
  requestPlan,
  type Config,
  type ScopedConfig,
} from '../src/runner.ts'
import type { OverlayWrite } from '../src/overlay.ts'

const ROOT = '/work/repo'
const OVERLAY = '/work/overlay'

const PLAN = {
  request: 'run the tests',
  steps: [{ tool: 'read', arguments: { file_path: 'src/a.ts' } }],
}

/** Limits shared by every test configuration. */
const LIMITS = {
  maxInputBytes: 4_096,
  maxOutputTokens: 512,
  timeoutMs: 5_000,
  maxSteps: 4,
  maxRequestChars: 200,
}

function config(overrides: Partial<Config> = {}): ScopedConfig {
  return {
    workspaceRoot: ROOT,
    overlayRoot: OVERLAY,
    allowWrites: true,
    provider: 'mock',
    model: 'mock-fast',
    ...LIMITS,
    ...overrides,
  }
}

/** A configuration missing one half of the auxiliary route. */
function routeless(field: 'provider' | 'model'): ScopedConfig {
  return {
    workspaceRoot: ROOT,
    overlayRoot: OVERLAY,
    allowWrites: true,
    ...LIMITS,
    ...field === 'provider' ? { model: 'mock-fast' } : { provider: 'mock' },
  }
}

const TOOLS: ToolSchema[] = [{
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
}]

function stubLlm(reply: string) {
  return {
    prepareCall: () => Promise.resolve({
      config: { provider: 'mock', model: 'mock-fast', maxTokens: 512 },
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
}

describe('parsePlan', () => {
  it('parses a bare forecast and defaults missing arguments', () => {
    expect(parsePlan(JSON.stringify(PLAN), 4)).toEqual({
      request: 'run the tests',
      steps: [{ tool: 'read', args: { file_path: 'src/a.ts' } }],
    })
    expect(parsePlan('{"request":"go","steps":[{"tool":"ls"}]}', 4).steps).toEqual([{ tool: 'ls', args: {} }])
    expect(parsePlan('{"request":"go"}', 4).steps).toEqual([])
  })

  it('extracts the object from a fenced reply and caps the step count', () => {
    const fenced = 'Here you go:\n```json\n'
      + JSON.stringify({ request: 'go', steps: [{ tool: 'read', arguments: {} }, { tool: 'ls', arguments: {} }] })
      + '\n```'
    expect(parsePlan(fenced, 1).steps).toEqual([{ tool: 'read', args: {} }])
  })

  it('rejects a reply with no JSON object', () => {
    expect(() => parsePlan('no forecast here', 4)).toThrow('not a JSON object')
    expect(() => parsePlan('{"request":', 4)).toThrow('not a JSON object')
  })

  it('rejects malformed JSON inside braces', () => {
    expect(() => parsePlan('{"request":}', 4)).toThrow(SyntaxError)
  })

  it('rejects a forecast that breaks the plan schema', () => {
    expect(() => parsePlan('{"request":42}', 4)).toThrow('does not match the plan schema')
  })

  it('rejects a forecast that names no request', () => {
    expect(() => parsePlan('{"request":"   "}', 4)).toThrow('named no request')
  })
})

describe('renderPlanInput', () => {
  it('frames both sections, the step cap, and the tool catalogue', () => {
    const input = renderPlanInput({ request: 'fix build', reply: 'fixed' }, TOOLS, 4_096, 3)
    expect(input).toContain('at most 3 tool calls')
    expect(input).toContain("User's last request:\nfix build")
    expect(input).toContain("Assistant's last reply:\nfixed")
    expect(input).toContain('"name":"read"')
  })

  it('omits absent sections and truncates over the cap', () => {
    const input = renderPlanInput({ reply: 'done' }, TOOLS, 4_096, 2)
    expect(input).not.toContain("User's last request")
    const truncated = renderPlanInput({ request: 'x'.repeat(2_000) }, TOOLS, 120, 2)
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(120)
  })
})

describe('matchesPrediction', () => {
  it('compares normalized text and rejects an empty message', () => {
    expect(matchesPrediction('Run  the tests', ' run the TESTS ')).toBe(true)
    expect(matchesPrediction('run the tests', 'run the linters')).toBe(false)
    expect(matchesPrediction('run the tests', '   ')).toBe(false)
  })
})

/** Fake filesystem recording the calls the overlay helpers make. */
function fakeFs(overrides: Record<string, unknown> = {}) {
  const written: string[] = []
  const base = {
    resolve: (path: string) => Promise.resolve({ path }),
    stat: () => Promise.resolve(undefined),
    readText: () => Promise.resolve('workspace'),
    writeText: (target: { path: string }) => {
      written.push(target.path)
      return Promise.resolve({})
    },
    remove: () => Promise.resolve(),
    ...overrides,
  }
  return { fs: base, written }
}

/** Fake tool service answering each call with a scripted outcome. */
function fakeTools(outcomes: (ToolBatchResult | Error)[]) {
  const calls: string[] = []
  const service = {
    schemas: () => TOOLS,
    execute: (input: { calls: readonly { name: string }[] }) => {
      const outcome = outcomes[calls.length]
      calls.push(input.calls[0]!.name)
      if (outcome === undefined) throw new Error('unscripted tool call')
      if (outcome instanceof Error) return Promise.reject(outcome)
      return Promise.resolve(outcome)
    },
  }
  return { service, calls }
}

function success(): ToolBatchResult {
  return {
    results: [{ callId: 'call' as never, result: { isError: false, value: null, content: [] } }],
    additionalContexts: [],
    concluded: false,
  }
}

function failure(): ToolBatchResult {
  return {
    results: [{ callId: 'call' as never, result: { isError: true, error: { message: 'boom' }, content: [] } }],
    additionalContexts: [],
    concluded: false,
  }
}

async function planContext(tools: unknown, fs: unknown) {
  const ctx = new Context()
  ctx.provide('tools', tools)
  ctx.provide('fs', fs)
  return ctx
}

describe('executePlan', () => {
  it('runs read-only calls in order and records the boundary that stops the plan', async () => {
    const { service, calls } = fakeTools([success(), { ...success(), results: [] }])
    const { fs } = fakeFs()
    const ctx = await planContext(service, fs)
    const steps = await executePlan(
      ctx,
      config(),
      { request: 'go', steps: [{ tool: 'read', args: { file_path: 'a.ts' } }, { tool: 'bash', args: {} }] },
      'call',
      new AbortController().signal,
      [],
    )
    expect(steps).toEqual([{ tool: 'read', status: 'read' }, { tool: 'bash', status: 'boundary' }])
    expect(calls).toEqual(['read'])
    await ctx.fiber.dispose()
  })

  it('redirects writes into the overlay, seeds the copy, and reports the pair', async () => {
    const { service } = fakeTools([success()])
    const { fs, written } = fakeFs({
      stat: (target: { path: string }) => Promise.resolve(
        target.path.startsWith(OVERLAY) ? undefined : { version: 'v', type: 'file' },
      ),
    })
    const ctx = await planContext(service, fs)
    const writes: OverlayWrite[] = []
    const steps = await executePlan(
      ctx,
      config(),
      { request: 'go', steps: [{ tool: 'write', args: { file_path: 'a.ts', content: 'x' } }] },
      'call',
      new AbortController().signal,
      writes,
    )
    expect(steps).toEqual([{ tool: 'write', status: 'overlay-write' }])
    expect(writes).toEqual([{ overlay: `${OVERLAY}/a.ts`, workspace: `${ROOT}/a.ts` }])
    // Seeding copies the workspace file into the overlay before the write runs.
    expect(written).toEqual([`${OVERLAY}/a.ts`])
    await ctx.fiber.dispose()
  })

  it('records a failed call without collecting it as an overlay write', async () => {
    const { service } = fakeTools([failure()])
    const { fs } = fakeFs()
    const ctx = await planContext(service, fs)
    const writes: OverlayWrite[] = []
    const steps = await executePlan(
      ctx,
      config(),
      { request: 'go', steps: [{ tool: 'write', args: { file_path: 'a.ts', content: 'x' } }] },
      'call',
      new AbortController().signal,
      writes,
    )
    expect(steps).toEqual([{ tool: 'write', status: 'failed' }])
    expect(writes).toEqual([])
    await ctx.fiber.dispose()
  })

  it('records a call the executor answered with no outcome as failed', async () => {
    const { service } = fakeTools([{ results: [], additionalContexts: [], concluded: false }])
    const { fs } = fakeFs()
    const ctx = await planContext(service, fs)
    const steps = await executePlan(
      ctx,
      config(),
      { request: 'go', steps: [{ tool: 'read', args: {} }] },
      'call',
      new AbortController().signal,
      [],
    )
    expect(steps).toEqual([{ tool: 'read', status: 'failed' }])
    await ctx.fiber.dispose()
  })

  it('stops before any call once the run is aborted', async () => {
    const { service } = fakeTools([success()])
    const { fs } = fakeFs()
    const ctx = await planContext(service, fs)
    const controller = new AbortController()
    controller.abort(new Error('superseded'))
    await expect(executePlan(
      ctx,
      config(),
      { request: 'go', steps: [{ tool: 'read', args: {} }] },
      'call',
      controller.signal,
      [],
    )).rejects.toThrow('superseded')
    await ctx.fiber.dispose()
  })

  it('stops a write the policy forbids before the tool runs', async () => {
    const policy = { readOnlyTools: ['read'], writeTools: ['write'], pathArgumentKeys: ['file_path'] }
    const { service } = fakeTools([success()])
    const { fs } = fakeFs()
    const ctx = await planContext(service, fs)
    const steps = await executePlan(
      ctx,
      config({ ...policy, allowWrites: false }),
      { request: 'go', steps: [{ tool: 'write', args: { file_path: 'a.ts' } }] },
      'call',
      new AbortController().signal,
      [],
    )
    expect(steps).toEqual([{ tool: 'write', status: 'boundary' }])
    await ctx.fiber.dispose()
  })
})

describe('requestPlan', () => {
  it('returns the parsed forecast and requires the route pair', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', stubLlm(JSON.stringify(PLAN)))
    expect(await requestPlan(ctx, session, config(), TOOLS, { request: 'go' }, new AbortController().signal))
      .toEqual({ request: 'run the tests', steps: [{ tool: 'read', args: { file_path: 'src/a.ts' } }] })
    await expect(requestPlan(
      ctx, session, routeless('model'), TOOLS, {}, new AbortController().signal,
    )).rejects.toThrow('provider and model must be configured together')
    await expect(requestPlan(
      ctx, session, routeless('provider'), TOOLS, {}, new AbortController().signal,
    )).rejects.toThrow('provider and model must be configured together')
    await ctx.fiber.dispose()
  })

  it('fails when the forecast carries no text', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    ctx.provide('llm', {
      prepareCall: () => Promise.resolve({
        config: { provider: 'mock', model: 'mock-fast', maxTokens: 512 },
        stream: async function* () {
          yield { type: 'reasoning-delta', index: 0, text: 'thinking' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    })
    await expect(requestPlan(ctx, session, config(), TOOLS, {}, new AbortController().signal))
      .rejects.toThrow('not a JSON object')
    await ctx.fiber.dispose()
  })
})

describe('apply configuration', () => {
  const cases: [string, Config, string][] = [
    ['a missing route', routeless('provider'), 'provider and model must be configured together'],
    ['a relative workspace root', config({ workspaceRoot: 'repo' }), 'workspaceRoot must be an absolute path'],
    ['a relative overlay root', config({ overlayRoot: 'overlay' }), 'overlayRoot must be an absolute path'],
    ['an overlay inside the workspace', config({ overlayRoot: `${ROOT}/.overlay` }), 'must live outside workspaceRoot'],
  ]

  it.each(cases)('rejects %s at load', async (_label, entries, message) => {
    const ctx = new Context()
    ctx.provide('llm', stubLlm(''))
    ctx.provide('tools', fakeTools([]).service)
    ctx.provide('fs', fakeFs().fs)
    await expect(ctx.plugin(Speculation, entries)).rejects.toThrow(message)
    await ctx.fiber.dispose()
  })
})

describe('apply', () => {
  let root: string
  let workspaceRoot: string
  let overlayRoot: string
  const contexts: Context[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-speculation-'))
    workspaceRoot = join(root, 'repo')
    overlayRoot = join(root, 'overlay')
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(overlayRoot, { recursive: true })
  })

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await rm(root, { recursive: true, force: true })
  })

  async function mount(options: {
    plan?: unknown
    allowWrites?: boolean
    outcomes?: (ToolBatchResult | Error)[]
    fs?: unknown
    llm?: unknown
    /** Omit `workspaceRoot` so each Session's own directory applies. */
    sessionRoots?: boolean
    /** Stand-in for the working-directory service, keyed by Session. */
    workingDirectory?: (session: Session) => string
  } = {}) {
    const ctx = new Context()
    contexts.push(ctx)
    if (options.fs === undefined) await ctx.plugin(LocalFileSystem, { cwd: workspaceRoot })
    else ctx.provide('fs', options.fs)
    ctx.provide('llm', options.llm ?? stubLlm(JSON.stringify(options.plan ?? PLAN)))
    if (options.outcomes === undefined) {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
      registerTools(ctx)
    } else {
      ctx.provide('tools', fakeTools(options.outcomes).service)
    }
    if (options.workingDirectory !== undefined) {
      ctx.provide('workingDirectory', { get: options.workingDirectory })
    }
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const base: Config = {
      overlayRoot,
      allowWrites: options.allowWrites ?? true,
      provider: 'mock',
      model: 'mock-fast',
      ...LIMITS,
    }
    await ctx.plugin(Speculation, options.sessionRoots === true ? base : { ...base, workspaceRoot })
    const proposals: { data: unknown }[] = []
    const outcomes: { data: unknown }[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'speculation/proposal') proposals.push(event)
      if (event.type === 'speculation/outcome') outcomes.push(event)
    })
    return { ctx, session, proposals, outcomes }
  }

  function registerTools(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'read',
      description: 'Read a file.',
      parameters: { file_path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args: { file_path: string }, exec) =>
        ctx.fs.readText(await ctx.fs.resolve(args.file_path, { signal: exec.signal }), exec.signal),
    }))
    ctx.tools.register(defineTool({
      name: 'write',
      description: 'Write a file.',
      parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args: { file_path: string; content: string }) => {
        await ctx.fs.writeText(await ctx.fs.resolve(args.file_path), args.content)
        return args.file_path
      },
    }))
  }

  function runTurn(session: Session, turn: number, request: string, reply: string): void {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: request }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: reply }],
        source: { provider: 'mock', model: 'mock-fast' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } as never })
  }

  function submit(session: Session, turn: number, request: string): void {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: request }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }

  it('resolves the workspace root from each Session working directory', async () => {
    const sessionDir = join(root, 'session-workspace')
    await mkdir(sessionDir, { recursive: true })
    const target = join(sessionDir, 'a.txt')
    const { ctx, session, proposals } = await mount({
      sessionRoots: true,
      workingDirectory: () => sessionDir,
      plan: { request: 'rewrite a', steps: [{ tool: 'write', arguments: { file_path: target, content: 'predicted' } }] },
    })
    runTurn(session, 1, 'look at a', 'done')
    await vi.waitFor(() => { expect(proposals).toHaveLength(1) }, { timeout: 5_000 })
    // The absolute path sits inside the Session directory, so the gate maps it into the overlay.
    expect(proposals[0]!.data).toMatchObject({ steps: [{ tool: 'write', status: 'overlay-write' }] })
    expect(await readFile(join(overlayRoot, 'a.txt'), 'utf8')).toBe('predicted')
    await ctx.fiber.dispose()
  })

  it('keeps a configured root authoritative over the Session directory', async () => {
    const sessionDir = join(root, 'session-workspace')
    await mkdir(sessionDir, { recursive: true })
    const target = join(sessionDir, 'a.txt')
    const { ctx, session, proposals } = await mount({
      workingDirectory: () => sessionDir,
      plan: { request: 'rewrite a', steps: [{ tool: 'write', arguments: { file_path: target, content: 'predicted' } }] },
    })
    runTurn(session, 1, 'look at a', 'done')
    await vi.waitFor(() => { expect(proposals).toHaveLength(1) }, { timeout: 5_000 })
    // The configured root is the deployment workspace, so this path is outside it.
    expect(proposals[0]!.data).toMatchObject({ steps: [{ tool: 'write', status: 'boundary' }] })
    await ctx.fiber.dispose()
  })

  it('skips a Session whose directory the policy cannot map', async () => {
    const relative = 'not-absolute'
    const { ctx, session, proposals } = await mount({
      sessionRoots: true,
      workingDirectory: () => relative,
    })
    runTurn(session, 1, 'look at a', 'done')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(proposals).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips a Session when no working directory and no configured root exist', async () => {
    const { ctx, session, proposals } = await mount({ sessionRoots: true })
    runTurn(session, 1, 'look at a', 'done')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(proposals).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips a Session whose directory contains the overlay', async () => {
    const { ctx, session, proposals } = await mount({
      sessionRoots: true,
      workingDirectory: () => root,
    })
    runTurn(session, 1, 'look at a', 'done')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(proposals).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('predicts after a completed turn and commits an accepted write', async () => {
    await writeFile(join(workspaceRoot, 'a.txt'), 'original')
    const { ctx, session, proposals, outcomes } = await mount({
      plan: { request: 'rewrite a', steps: [{ tool: 'write', arguments: { file_path: 'a.txt', content: 'predicted' } }] },
    })
    runTurn(session, 1, 'look at a', 'done')
    await vi.waitFor(() => { expect(proposals).toHaveLength(1) }, { timeout: 5_000 })
    expect(proposals[0]!.data).toEqual({
      turn: 1,
      predictedRequest: 'rewrite a',
      steps: [{ tool: 'write', status: 'overlay-write' }],
    })
    // The predicted write sits in the overlay until the user confirms it.
    expect(await readFile(join(workspaceRoot, 'a.txt'), 'utf8')).toBe('original')
    expect(await readFile(join(overlayRoot, 'a.txt'), 'utf8')).toBe('predicted')

    submit(session, 2, 'Rewrite A')
    await vi.waitFor(() => { expect(outcomes).toHaveLength(1) }, { timeout: 5_000 })
    expect(outcomes[0]!.data).toMatchObject({ turn: 1, decision: 'commit' })
    expect(await readFile(join(workspaceRoot, 'a.txt'), 'utf8')).toBe('predicted')
    await ctx.fiber.dispose()
  })

  it('discards a prediction the user did not confirm', async () => {
    await writeFile(join(workspaceRoot, 'a.txt'), 'original')
    const { ctx, session, proposals, outcomes } = await mount({
      plan: { request: 'rewrite a', steps: [{ tool: 'write', arguments: { file_path: 'a.txt', content: 'predicted' } }] },
    })
    runTurn(session, 1, 'look at a', 'done')
    await vi.waitFor(() => { expect(proposals).toHaveLength(1) }, { timeout: 5_000 })
    submit(session, 2, 'something else entirely')
    await vi.waitFor(() => { expect(outcomes).toHaveLength(1) }, { timeout: 5_000 })
    expect(outcomes[0]!.data).toMatchObject({ turn: 1, decision: 'discard' })
    expect(await readFile(join(workspaceRoot, 'a.txt'), 'utf8')).toBe('original')
    await ctx.fiber.dispose()
  })

  it('discards writes when the policy forbids them', async () => {
    await writeFile(join(workspaceRoot, 'a.txt'), 'original')
    const { ctx, session, proposals, outcomes } = await mount({
      allowWrites: false,
      plan: { request: 'rewrite a', steps: [{ tool: 'write', arguments: { file_path: 'a.txt', content: 'predicted' } }] },
    })
    runTurn(session, 1, 'look at a', 'done')
    await vi.waitFor(() => { expect(proposals).toHaveLength(1) }, { timeout: 5_000 })
    expect(proposals[0]!.data).toMatchObject({ steps: [{ tool: 'write', status: 'boundary' }] })
    submit(session, 2, 'rewrite a')
    await vi.waitFor(() => { expect(outcomes).toHaveLength(1) }, { timeout: 5_000 })
    expect(outcomes[0]!.data).toMatchObject({ decision: 'discard', paths: [] })
    await ctx.fiber.dispose()
  })

  it('abandons a prediction the user supersedes mid-flight', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: workspaceRoot })
    ctx.provide('llm', {
      prepareCall: () => Promise.resolve({
        config: { provider: 'mock', model: 'mock-fast', maxTokens: 512 },
        stream: async function* () {
          await gate
          yield { type: 'text-delta', index: 0, text: JSON.stringify(PLAN) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    registerTools(ctx)
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    await ctx.plugin(Speculation, config({ workspaceRoot, overlayRoot }))
    const proposals: unknown[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'speculation/proposal') proposals.push(event)
    })
    runTurn(session, 1, 'look at a', 'done')
    submit(session, 2, 'never mind')
    release?.()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(proposals).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips replayed turns and turns without text', async () => {
    const { ctx, session, proposals } = await mount()
    session.append('turn/start', { turn: 1 })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    ctx.emit('session/event', session, end)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(proposals).toHaveLength(0)

    runTurn(session, 2, 'look at a', 'done')
    await vi.waitFor(() => { expect(proposals).toHaveLength(1) }, { timeout: 5_000 })
    const endOfTurn = session.snapshotEvents().find(event => event.type === 'turn/end' && event.data.turn === 2)
    ctx.emit('session/event', session, endOfTurn!)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(proposals).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('warns instead of throwing when the forecast request fails', async () => {
    const { ctx, session, proposals } = await mount({
      llm: { prepareCall: () => Promise.reject(new Error('no route')) },
    })
    const warn = vi.spyOn(ctx.logger, 'warn')
    runTurn(session, 1, 'look at a', 'done')
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() }, { timeout: 5_000 })
    expect(proposals).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('abandons an in-flight prediction when the plugin unloads', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { ctx, session, proposals } = await mount({
      llm: {
        prepareCall: () => Promise.resolve({
          config: { provider: 'mock', model: 'mock-fast', maxTokens: 512 },
          stream: async function* () {
            await gate
            yield { type: 'text-delta', index: 0, text: JSON.stringify(PLAN) }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }),
      },
    })
    runTurn(session, 1, 'look at a', 'done')
    await new Promise(resolve => setTimeout(resolve, 30))
    await ctx.fiber.dispose()
    release?.()
    expect(proposals).toHaveLength(0)
  })

  it('discards when the confirming message carries no text', async () => {
    const { ctx, session, proposals, outcomes } = await mount()
    runTurn(session, 1, 'look at a', 'done')
    await vi.waitFor(() => { expect(proposals).toHaveLength(1) }, { timeout: 5_000 })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'reasoning', text: 'hmm' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await vi.waitFor(() => { expect(outcomes).toHaveLength(1) }, { timeout: 5_000 })
    expect(outcomes[0]!.data).toMatchObject({ decision: 'discard' })
    await ctx.fiber.dispose()
  })

  it('warns when abandonment cannot remove the overlay copies', async () => {
    const present = () => Promise.resolve({ version: 'v', type: 'file' })
    const { fs } = fakeFs({ stat: present, remove: () => Promise.reject(new Error('locked')) })
    const { ctx, session } = await mount({
      fs,
      outcomes: [success(), new Error('executor failed')],
      plan: {
        request: 'rewrite a',
        steps: [
          { tool: 'write', arguments: { file_path: 'a.txt', content: 'predicted' } },
          { tool: 'read', arguments: { file_path: 'a.txt' } },
        ],
      },
    })
    const warn = vi.spyOn(ctx.logger, 'warn')
    runTurn(session, 1, 'look at a', 'done')
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('locked')) }, { timeout: 5_000 })
    await ctx.fiber.dispose()
  })

  it('warns when the prediction cannot be settled', async () => {
    const present = () => Promise.resolve({ version: 'v', type: 'file' })
    const { fs } = fakeFs({ stat: present, writeText: () => Promise.reject(new Error('read-only')) })
    const { ctx, session, proposals, outcomes } = await mount({
      fs,
      outcomes: [success()],
      plan: { request: 'run the tests', steps: [{ tool: 'write', arguments: { file_path: 'a.txt', content: 'x' } }] },
    })
    const warn = vi.spyOn(ctx.logger, 'warn')
    runTurn(session, 1, 'look at a', 'done')
    await vi.waitFor(() => { expect(proposals).toHaveLength(1) }, { timeout: 5_000 })
    submit(session, 2, 'run the tests')
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('read-only')) }, { timeout: 5_000 })
    expect(outcomes).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
