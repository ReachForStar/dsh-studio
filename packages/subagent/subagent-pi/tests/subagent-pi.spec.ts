import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as pi from '../src/index.ts'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  disposePiChild,
  piRpcArgv,
  startPiRun,
  textTask,
  type PiRunSpec,
} from '../src/run.ts'
import { PiRpcWire } from '../src/wire.ts'

const tsxLoader = import.meta.resolve('tsx')
const fixturePath = fileURLToPath(new URL('./pi-rpc-fixture.ts', import.meta.url))
/** The exact answer the `complete` fixture scenarios return. */
const SENTINEL = 'PI_FIXTURE_SENTINEL_0_84'

const roots: string[] = []
const contexts: Context[] = []
const handles: SubprocessHandle[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  }
})

describe('textTask', () => {
  it('rejects an empty prompt', () => {
    expect(() => textTask([])).toThrow(/must contain only text blocks/)
  })
  it('rejects a non-text block', () => {
    // The block shape is irrelevant to the guard under test; the runtime
    // rejection keys on the block type alone.
    expect(() => textTask([{ type: 'image', attachment: {} }] as unknown as Parameters<typeof textTask>[0]))
      .toThrow(/must contain only text blocks/)
  })
  it('rejects all-blank text', () => {
    expect(() => textTask([{ type: 'text', text: '  \n ' }])).toThrow(/must not be empty/)
  })
  it('joins text blocks into one task', () => {
    expect(textTask([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })
})

describe('piRpcArgv', () => {
  it('wraps the fixed command in cmd.exe on Windows', () => {
    expect(piRpcArgv('win32')).toEqual(['cmd.exe', '/d', '/s', '/c', 'pi', '--mode', 'rpc'])
  })
  it('spawns the fixed command directly on POSIX', () => {
    expect(piRpcArgv('darwin')).toEqual(['pi', '--mode', 'rpc'])
  })
  it('honours a configured command and args', () => {
    expect(piRpcArgv('win32', 'node', ['--import', 'tsx', 'fixture.ts']))
      .toEqual(['cmd.exe', '/d', '/s', '/c', 'node', '--import', 'tsx', 'fixture.ts'])
  })
})

describe('config validation', () => {
  function stubCtx(): Context {
    return {
      subagents: { registerProvider: vi.fn() },
      logger: { warn: vi.fn() },
    } as unknown as Context
  }

  // The Loader normally applies the Config schema (defaults); these tests
  // call apply() directly, so each case passes the fully resolved shape.
  function resolvedConfig(overrides: Partial<pi.Config>): pi.Config {
    return {
      env: {},
      disposeEofGraceMs: 6_000,
      disposeGraceMs: 3_000,
      command: 'pi',
      args: ['--mode', 'rpc'],
      ...overrides,
    }
  }

  it('rejects a non-positive disposeGraceMs', () => {
    expect(() => { pi.apply(stubCtx(), resolvedConfig({ disposeGraceMs: 0 })) })
      .toThrow(/disposeGraceMs must be a positive finite number/)
  })
  it('rejects a non-positive disposeEofGraceMs', () => {
    expect(() => { pi.apply(stubCtx(), resolvedConfig({ disposeEofGraceMs: NaN })) })
      .toThrow(/disposeEofGraceMs must be a positive finite number/)
  })
  it('rejects a disposeGraceMs above the timer ceiling', () => {
    expect(() => { pi.apply(stubCtx(), resolvedConfig({ disposeGraceMs: 2 ** 31 })) })
      .toThrow(/no greater than/)
  })
  it('rejects a disposeEofGraceMs above the timer ceiling', () => {
    expect(() => { pi.apply(stubCtx(), resolvedConfig({ disposeEofGraceMs: 2 ** 31 })) })
      .toThrow(/disposeEofGraceMs must be no greater than/)
  })
  it('rejects a relative agentDir', () => {
    expect(() => { pi.apply(stubCtx(), resolvedConfig({ agentDir: 'relative/.pi' })) })
      .toThrow(/agentDir must be an absolute path/)
  })
  it('rejects a relative sessionDir', () => {
    expect(() => { pi.apply(stubCtx(), resolvedConfig({ sessionDir: 'relative/sessions' })) })
      .toThrow(/sessionDir must be an absolute path/)
  })
  it('registers the provider under the fixed name', () => {
    const registerProvider = vi.fn()
    const ctx = { subagents: { registerProvider }, logger: { warn: vi.fn() } } as unknown as Context
    pi.apply(ctx, resolvedConfig({}))
    expect(registerProvider).toHaveBeenCalledOnce()
    const provider = registerProvider.mock.calls[0]![0] as { name: string }
    expect(provider.name).toBe('pi')
  })
})

describe('PiRpcWire protocol adapter', () => {
  function pair(): {
    readonly wire: PiRpcWire
    readonly input: PassThrough
    readonly output: PassThrough
    readonly sent: Array<Record<string, unknown>>
  } {
    const input = new PassThrough()
    const output = new PassThrough()
    const sent: Array<Record<string, unknown>> = []
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.length > 0) sent.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
    const wire = new PiRpcWire(input, output)
    return { wire, input, output, sent }
  }

  it('correlates a response by id and exposes its data', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    const written = sent[0]!
    expect(written.type).toBe('get_state')
    expect(typeof written.id).toBe('string')
    input.write(`${JSON.stringify({
      id: written.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 's1' },
    })}\n`)
    await expect(ready).resolves.toBeUndefined()
  })

  it('rejects a failed response with the Pi error text', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({
      id: sent[0]!.id,
      type: 'response',
      command: 'get_state',
      success: false,
      error: 'fixture broke',
    })}\n`)
    await expect(ready).rejects.toThrow(/fixture broke/)
  })

  it('rejects when the response lacks a command id', async () => {
    const { wire, input } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({ type: 'response', command: 'get_state', success: true })}\n`)
    await expect(ready).rejects.toThrow(/lacks a command id/)
  })

  it('ignores a response for an unknown id', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({ id: 'stranger', type: 'response', command: 'x', success: true })}\n`)
    input.write(`${JSON.stringify({
      id: sent[0]!.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 's1' },
    })}\n`)
    await expect(ready).resolves.toBeUndefined()
  })

  it('resolves waitSettled on the agent_settled event', async () => {
    const { wire, input } = pair()
    wire.start()
    const settled = wire.waitSettled(new AbortController().signal)
    input.write(`${JSON.stringify({ type: 'agent_settled' })}\n`)
    await expect(settled).resolves.toBeUndefined()
  })

  it('auto-cancels extension UI dialogs', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({ type: 'extension_ui_request', id: 'ui-1', method: 'select' })}\n`)
    input.write(`${JSON.stringify({
      id: sent[0]!.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 's1' },
    })}\n`)
    await ready
    await new Promise((resolve) => { setImmediate(resolve) })
    const frames = sent.filter(frame => frame.type === 'extension_ui_response')
    expect(frames).toEqual([{ type: 'extension_ui_response', id: 'ui-1', cancelled: true }])
  })

  it('fails the connection on an unparseable protocol line', async () => {
    const { wire, input } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write('not json\n')
    await expect(ready).rejects.toThrow(/unparseable protocol line/)
  })

  it('fails the connection on an extension error', async () => {
    const { wire, input } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({ type: 'extension_error', error: 'boom' })}\n`)
    await expect(ready).rejects.toThrow(/extension failed: boom/)
  })

  it('rejects a command after close', async () => {
    const { wire } = pair()
    wire.start()
    wire.close()
    await expect(wire.ready(new AbortController().signal)).rejects.toThrow(/connection is closed/)
  })

  it('returns an empty output snapshot and idempotent close', () => {
    const { wire } = pair()
    wire.start()
    expect(wire.collectOutput()).toEqual([])
    wire.close()
    wire.close()
  })

  it('rejects an invalid last-assistant text type', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const pending = wire.lastAssistantText(new AbortController().signal)
    input.write(`${JSON.stringify({
      id: sent[0]!.id,
      type: 'response',
      command: 'get_last_assistant_text',
      success: true,
      data: { text: 42 },
    })}\n`)
    await expect(pending).rejects.toThrow(/invalid text/)
  })

  it('fails the connection when the input stream ends', async () => {
    const { wire, input } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.end()
    await expect(ready).rejects.toThrow(/protocol stream closed/)
  })

  it('skips blank protocol lines', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write('\n\n')
    input.write(`${JSON.stringify({
      id: sent[0]!.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 's1' },
    })}\n`)
    await expect(ready).resolves.toBeUndefined()
  })

  it('ignores non-dialog extension UI requests', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hi' })}\n`)
    input.write(`${JSON.stringify({
      id: sent[0]!.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 's1' },
    })}\n`)
    await expect(ready).resolves.toBeUndefined()
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(sent.filter(frame => frame.type === 'extension_ui_response')).toEqual([])
  })

  it('ignores an extension UI request without an id', async () => {
    const { wire, input } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({ type: 'extension_ui_request', method: 'select' })}\n`)
    input.end()
    await expect(ready).rejects.toThrow(/protocol stream closed/)
  })

  it('fails on an extension error with a non-string payload', async () => {
    const { wire, input } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({ type: 'extension_error', error: { code: 1 } })}\n`)
    await expect(ready).rejects.toThrow(/extension failed: \{"code":1\}/)
  })

  it('rejects a failed response with an object error', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({
      id: sent[0]!.id,
      type: 'response',
      command: 'get_state',
      success: false,
      error: { message: 'boom' },
    })}\n`)
    await expect(ready).rejects.toThrow(/"message":"boom"/)
  })

  it('rejects a failed response without an error', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({
      id: sent[0]!.id,
      type: 'response',
      command: 'get_state',
      success: false,
    })}\n`)
    await expect(ready).rejects.toThrow(/unknown error/)
  })

  it('rejects a get_state response without a session id', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({
      id: sent[0]!.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: {},
    })}\n`)
    await expect(ready).rejects.toThrow(/lacks a session id/)
  })

  it('returns immediately when the turn already settled', async () => {
    const { wire, input } = pair()
    wire.start()
    input.write(`${JSON.stringify({ type: 'agent_settled' })}\n`)
    await wire.waitSettled(new AbortController().signal)
    await expect(wire.waitSettled(new AbortController().signal)).resolves.toBeUndefined()
  })

  it('no-ops abort after close', () => {
    const { wire } = pair()
    wire.start()
    wire.close()
    wire.abort()
  })

  it('rejects with the abort reason when it is not an Error', async () => {
    const { wire } = pair()
    wire.start()
    const controller = new AbortController()
    const ready = wire.ready(controller.signal)
    controller.abort('plain reason')
    await expect(ready).rejects.toThrow(/Pi request aborted: plain reason/)
  })

  it('fails the connection on an input stream error', async () => {
    const { wire, input } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.emit('error', new Error('read failed'))
    await expect(ready).rejects.toThrow(/read failed/)
  })

  it('fails the connection on an output stream error', async () => {
    const { wire, output } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    output.emit('error', new Error('write pipe failed'))
    await expect(ready).rejects.toThrow(/write pipe failed/)
  })

  it('ignores unknown event frames', async () => {
    const { wire, input, sent } = pair()
    wire.start()
    const ready = wire.ready(new AbortController().signal)
    input.write(`${JSON.stringify({ type: 'message_update', usage: {} })}\n`)
    input.write(`${JSON.stringify({
      id: sent[0]!.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 's1' },
    })}\n`)
    await expect(ready).resolves.toBeUndefined()
  })

  it('rejects with the abort reason when it is an Error', async () => {
    const { wire } = pair()
    wire.start()
    const controller = new AbortController()
    const ready = wire.ready(controller.signal)
    controller.abort(new Error('boom'))
    await expect(ready).rejects.toThrow(/boom/)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const { wire } = pair()
    wire.start()
    const controller = new AbortController()
    controller.abort(new Error('pre-aborted'))
    await expect(wire.ready(controller.signal)).rejects.toThrow(/pre-aborted/)
  })

  it('rejects the request when the output write fails', async () => {
    const { wire, output } = pair()
    wire.start()
    vi.spyOn(output, 'write').mockImplementation(((
      _chunk: unknown,
      callback: (error?: Error) => void,
    ) => {
      callback(new Error('write failed'))
      return true
    }) as never)
    await expect(wire.ready(new AbortController().signal)).rejects.toThrow(/write failed/)
  })

  it('settles exactly once when abort races the write failure', async () => {
    const { wire, output } = pair()
    wire.start()
    // The write callback is deferred so the abort settles first; the later
    // write failure must be swallowed by the double-settle guard.
    vi.spyOn(output, 'write').mockImplementation(((
      _chunk: unknown,
      callback: (error?: Error) => void,
    ) => {
      setImmediate(() => { callback(new Error('write failed')) })
      return true
    }) as never)
    const controller = new AbortController()
    const ready = wire.ready(controller.signal)
    controller.abort('race')
    await expect(ready).rejects.toThrow(/Pi request aborted: race/)
  })
})

describe('provider runs against a scripted Pi RPC child', () => {
  async function harness(scenario: string): Promise<{
    readonly ctx: Context
    readonly parent: Agent
  }> {
    const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-pi-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec)
      handles.push(handle)
      return handle
    })
    await ctx.plugin(pi, {
      env: {},
      command: 'node',
      args: ['--import', tsxLoader, fixturePath, scenario],
      disposeEofGraceMs: 500,
      disposeGraceMs: 500,
    })
    const parent = {
      id: 'pi-unit-parent',
      session: { header: { cwd: root } },
    } as unknown as Agent
    return { ctx, parent }
  }

  async function expectQuiescent(): Promise<void> {
    expect(handles.length).toBeGreaterThan(0)
    for (const handle of handles.splice(0)) {
      await expect(handle.waitForExit()).resolves.toBe(true)
      const outcome = await handle.done
      expect(outcome).toHaveProperty('exitCode')
      expect(outcome).toHaveProperty('signal')
    }
  }

  it('completes with the exact fixture answer', async () => {
    const { ctx, parent } = await harness('complete')
    const run = await ctx.subagents.start('pi', {
      prompt: [{ type: 'text', text: 'Return the sentinel.' }],
      parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: SENTINEL }],
      stopReason: 'completed',
    })
    await run.dispose()
    await expectQuiescent()
  })

  it('auto-cancels an extension dialog and still completes', async () => {
    const { ctx, parent } = await harness('extension-ui')
    const run = await ctx.subagents.start('pi', {
      prompt: [{ type: 'text', text: 'Pick something.' }],
      parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: SENTINEL }],
      stopReason: 'completed',
    })
    await run.dispose()
    await expectQuiescent()
  })

  it('maps a settled-without-answer child to error', async () => {
    const { ctx, parent } = await harness('no-answer')
    const run = await ctx.subagents.start('pi', {
      prompt: [{ type: 'text', text: 'Say nothing.' }],
      parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'error',
    })
    await run.dispose()
    await expectQuiescent()
  })

  it('maps a rejected prompt to error', async () => {
    const { ctx, parent } = await harness('prompt-error')
    const run = await ctx.subagents.start('pi', {
      prompt: [{ type: 'text', text: 'Will fail preflight.' }],
      parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    await run.dispose()
    await expectQuiescent()
  })

  it('maps an unparseable child stream to error', async () => {
    const { ctx, parent } = await harness('bad-json')
    const run = await ctx.subagents.start('pi', {
      prompt: [{ type: 'text', text: 'Produce garbage.' }],
      parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    await run.dispose()
    await expectQuiescent()
  })

  it('rejects start when the request is already aborted', async () => {
    const { ctx, parent } = await harness('complete')
    const controller = new AbortController()
    controller.abort(new Error('pre-aborted'))
    await expect(ctx.subagents.start('pi', {
      prompt: [{ type: 'text', text: 'Never mind.' }],
      parent,
      signal: controller.signal,
    })).rejects.toThrow(/aborted before Pi startup/)
    // No child is spawned when the request is already cancelled.
    expect(handles).toHaveLength(0)
  })

  it('rejects start when the child exits before readiness', async () => {
    const { ctx, parent } = await harness('crash')
    await expect(ctx.subagents.start('pi', {
      prompt: [{ type: 'text', text: 'Crash.' }],
      parent,
      signal: new AbortController().signal,
    })).rejects.toThrow(/exited before the run settled|protocol stream closed/)
    await expectQuiescent()
  })

  it('settles cancellation locally and leaves the child quiescent', async () => {
    const { ctx, parent } = await harness('hold')
    const controller = new AbortController()
    const run = await ctx.subagents.start('pi', {
      prompt: [{ type: 'text', text: 'Wait forever.' }],
      parent,
      signal: controller.signal,
    })
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    controller.abort(new Error('unit cancellation'))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await run.dispose()
    await expectQuiescent()
  })
})

type JsonObject = Record<string, unknown>

const fakeParent = {
  id: 'parent',
  session: { header: { cwd: process.cwd() } },
} as unknown as Agent

function request(
  prompt: ContentBlock[] = [{ type: 'text', text: 'do the task' }],
  signal = new AbortController().signal,
): Parameters<typeof startPiRun>[0] {
  return { prompt, parent: fakeParent, signal }
}

interface FakeChildOptions {
  readonly pid?: number
  readonly exitOnTerminate?: boolean
  readonly doneError?: Error
}

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly fromChild: PassThrough
  readonly toChild: PassThrough
  readonly settle: (outcome?: SubprocessOutcome) => void
  readonly fail: (error: Error) => void
  readonly terminate: ReturnType<typeof vi.fn>
  readonly waitForExit: ReturnType<typeof vi.fn>
}

function fakeChild(options: FakeChildOptions = {}): FakeChild {
  const fromChild = new PassThrough()
  const toChild = new PassThrough()
  let exited = false
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const settle = (outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void => {
    if (exited) return
    exited = true
    resolveDone(outcome)
  }
  const fail = (error: Error): void => {
    if (exited) return
    exited = true
    rejectDone(error)
  }
  if (options.doneError !== undefined) fail(options.doneError)
  const terminate = vi.fn(() => {
    if (options.exitOnTerminate !== false) settle()
  })
  const waitForExit = vi.fn(async () => {
    if (exited) return true
    await done.catch(() => {})
    return true
  })
  const handle: SubprocessHandle = {
    pid: options.pid ?? 1234,
    stdin: toChild,
    stdout: fromChild,
    stderr: undefined,
    collected: {},
    done,
    terminate,
    waitForExit,
  }
  return { handle, fromChild, toChild, settle, fail, terminate, waitForExit }
}

function runSpec(
  child: FakeChild,
  overrides: Partial<PiRunSpec> = {},
): PiRunSpec {
  return {
    cwd: process.cwd(),
    env: {},
    command: 'pi',
    args: ['--mode', 'rpc'],
    disposeEofGraceMs: 500,
    disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    spawn: () => child.handle,
    ...overrides,
  }
}

/** Collects one line-framed JSON command written by the provider. */
function frameReader(stream: PassThrough): () => Promise<JsonObject> {
  const frames: JsonObject[] = []
  stream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.length > 0) frames.push(JSON.parse(line) as JsonObject)
    }
  })
  return async (): Promise<JsonObject> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const frame = frames.shift()
      if (frame !== undefined) return frame
      await new Promise((resolve) => { setTimeout(resolve, 5) })
    }
    throw new Error('timed out waiting for a provider command frame')
  }
}

describe('startPiRun rollback paths', () => {
  it('rejects before spawn when pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()
    await expect(startPiRun(
      request(undefined, controller.signal),
      { ...runSpec(fakeChild()), spawn },
    )).rejects.toThrow('aborted before Pi startup')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rolls back an abort that wins during the readiness probe', async () => {
    const controller = new AbortController()
    const child = fakeChild()
    const starting = startPiRun(
      request(undefined, controller.signal),
      runSpec(child),
    )
    const next = frameReader(child.toChild)
    const probe = await next()
    expect(probe.type).toBe('get_state')
    controller.abort('startup race')
    await expect(starting).rejects.toThrow('aborted before run publication')
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('rolls back a subprocess done rejection during startup', async () => {
    const child = fakeChild({ doneError: new Error('spawn observer failed') })
    const error: unknown = await startPiRun(request(), runSpec(child)).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) {
      throw new Error('expected startup and rollback failures')
    }
    expect(error.errors).toEqual([
      expect.objectContaining({ message: 'spawn observer failed' }),
      expect.objectContaining({ message: 'spawn observer failed' }),
    ])
  })
})

describe('disposePiChild', () => {
  it('prefers the cooperative EOF shutdown and skips termination when the child exits', async () => {
    const child = fakeChild()
    const wire = new PiRpcWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    const end = vi.spyOn(child.toChild, 'end')
    const disposal = disposePiChild(wire, child.handle, 500)
    child.settle()
    await disposal
    expect(end).toHaveBeenCalled()
    expect(child.terminate).not.toHaveBeenCalled()
  })

  it('escalates to termination when the child ignores EOF', async () => {
    const child = fakeChild()
    const wire = new PiRpcWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    // A one-millisecond grace guarantees the delay settles the EOF race
    // before the child exits cooperatively.
    await disposePiChild(wire, child.handle, 1)
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledTimes(1)
  })

  it('handles a spawn-level failure with no process tree', async () => {
    const child = fakeChild({
      pid: -1,
      doneError: new Error('spawn failed'),
    })
    const wire = new PiRpcWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    await expect(disposePiChild(wire, child.handle, 500))
      .resolves.toBeUndefined()
    expect(child.terminate).not.toHaveBeenCalled()
    expect(child.waitForExit).not.toHaveBeenCalled()
  })

  it('contains a concurrently closed stdin error', async () => {
    const child = fakeChild()
    const wire = new PiRpcWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    vi.spyOn(child.toChild, 'end').mockImplementation(() => {
      throw new Error('already closed')
    })
    await expect(disposePiChild(wire, child.handle, 500))
      .resolves.toBeUndefined()
  })
})
