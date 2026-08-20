/**
 * One-shot Pi coding agent child lifecycle: spawn the real Pi RPC server
 * through the subprocess seam, publish only after the RPC server is ready,
 * flatten post-publication failures, and dispose to whole-tree quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-pi/run
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { PiRpcWire } from './wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000
/** Default grace for Pi's cooperative EOF shutdown before termination. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Resolve the Pi RPC command for a platform. Windows npm and pnpm installs
 * expose `pi.cmd`, which requires `cmd.exe`; the argv is constant (or, for a
 * configured `command`/`args` pair, validated deployment data), so no task or
 * configuration text enters the shell boundary.
 * @param platform - host platform used to select the executable boundary.
 * @param command - the Pi executable (bare name) or a test fixture launcher.
 * @param args - fixed Pi RPC arguments.
 * @returns argv for the Pi RPC command.
 */
export function piRpcArgv(
  platform: NodeJS.Platform = process.platform,
  command = 'pi',
  args: readonly string[] = ['--mode', 'rpc'],
): string[] {
  return platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', command, ...args]
    : [command, ...args]
}

/** Fully resolved inputs for one Pi RPC run. */
export interface PiRunSpec {
  /** Parent Session workspace, also the child's working directory. */
  readonly cwd: string
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Pi executable (bare name) or a test fixture launcher. */
  readonly command: string
  /** Fixed Pi RPC arguments. */
  readonly args: readonly string[]
  /** Grace for Pi's cooperative EOF shutdown before termination. */
  readonly disposeEofGraceMs: number
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact concatenated non-empty text task.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-pi: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-pi: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  const text = texts.join('\n')
  if (text.trim().length === 0) {
    throw new Error('subagent-pi: the one-shot task must not be empty')
  }
  return text
}

/**
 * Close the private wire, ask the child to shut down cooperatively through
 * stdin EOF, escalate to the shared process-tree termination after the EOF
 * grace, and wait for the subprocess owner to prove it is gone.
 * @param wire - private Pi RPC protocol connection.
 * @param child - shared-service handle that owns the process tree.
 * @param eofGraceMs - bound on the cooperative EOF shutdown window.
 */
export async function disposePiChild(
  wire: PiRpcWire,
  child: SubprocessHandle,
  eofGraceMs: number,
): Promise<void> {
  wire.close()
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  try {
    child.stdin?.end()
  } catch {
    // A concurrently closed stdin does not change tree ownership below.
  }
  const eof = child.done.then(
    () => true,
    () => true,
  )
  const exited = await Promise.race([eof, delay(eofGraceMs).then(() => false)])
  if (!exited) {
    child.terminate()
  }
  await child.waitForExit()
  await child.done
}

/**
 * Start the real `pi --mode rpc` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - workspace, environment, process service, and diagnostic policy.
 * @returns the published run after the RPC server answered its readiness probe.
 */
export async function startPiRun(
  request: SubagentStartRequest,
  spec: PiRunSpec,
): Promise<SubagentRun> {
  const text = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-pi: request was aborted before Pi startup')
  }

  const child = spec.spawn({
    argv: piRpcArgv(process.platform, spec.command, spec.args),
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
  })

  const wire = new PiRpcWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
  )
  const disposeProcess = (): Promise<void> => disposePiChild(
    wire,
    child,
    spec.disposeEofGraceMs,
  )

  const processFailure: Promise<never> = child.done.then(
    outcome => Promise.reject(new Error(
      'subagent-pi: Pi exited before the run settled '
      + `(code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
    )),
    (error: unknown) => Promise.reject(thrown(error)),
  )
  // A normal post-result dispose also closes the process. Keep that expected
  // late rejection observed after the result race has already settled.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-pi: run cancelled locally'))
    wire.abort()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  try {
    wire.start()
    await Promise.race([wire.ready(request.signal), processFailure])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      throw new AggregateError(
        [thrown(error), thrown(disposeError)],
        'subagent-pi: startup failed and Pi cleanup also failed',
      )
    }
    if (runAbort.signal.aborted) {
      throw new Error('subagent-pi: request was aborted before run publication')
    }
    throw thrown(error)
  }

  const collectOutput = (): ContentBlock[] => wire.collectOutput()
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: () => Promise.race([
      wire.runTurn(text, runAbort.signal),
      processFailure,
    ]),
    collectOutput,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
