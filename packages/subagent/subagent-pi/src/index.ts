/**
 * Fixed Pi coding agent one-shot subagent provider. Every accepted run starts
 * a fresh `pi --mode rpc` process in the delegating Session's workspace and
 * publishes only after the RPC server answered a readiness probe.
 *
 * @module @deepseek-ai/dsh-subagent-pi
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  startPiRun,
  type PiRunSpec,
} from './run.ts'

export const name = 'subagent-pi'
export const inject = ['subagents', 'subprocess']

/** Deployment-owned environment, process-release bounds, and Pi directories. */
export interface Config {
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment. Pi credentials (for example
   * `DEEPSEEK_API_KEY`) and any Pi extension variables belong here.
   */
  env?: Record<string, string>
  /** Grace in milliseconds for Pi's cooperative EOF shutdown before termination. */
  disposeEofGraceMs?: number
  /** Grace in milliseconds for app-server process-tree termination. */
  disposeGraceMs?: number
  /**
   * Pi executable (bare name on `PATH`) or a test fixture launcher; the
   * provider appends `--mode rpc`.
   */
  command?: string
  /** Fixed arguments appended after the Pi executable. */
  args?: string[]
  /**
   * Absolute `PI_CODING_AGENT_DIR` override naming where Pi keeps agent
   * settings and trust state. When omitted, Pi uses its native home
   * (`~/.pi/agent`). Wins over an `env.PI_CODING_AGENT_DIR` entry.
   */
  agentDir?: string
  /**
   * Absolute `PI_CODING_AGENT_SESSION_DIR` override naming where Pi keeps
   * session files. When omitted, Pi uses its native session location. Wins
   * over an `env.PI_CODING_AGENT_SESSION_DIR` entry.
   */
  sessionDir?: string
}

export const Config: z<Config> = z.object({
  env: z.dict(z.string()).default({}),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  command: z.string().default('pi'),
  args: z.array(z.string()).default(['--mode', 'rpc']),
  agentDir: z.string(),
  sessionDir: z.string(),
})

/** The shape after schemastery applied the defaults (the dirs have none). */
type ResolvedConfig = Required<Omit<Config, 'agentDir' | 'sessionDir'>> & Pick<Config, 'agentDir' | 'sessionDir'>

function assertAbsoluteDir(
  prefix: string,
  field: 'agentDir' | 'sessionDir',
  value: string | undefined,
): void {
  if (value === undefined) return
  if (!isAbsolute(value)) {
    throw new Error(`${prefix}: config ${field} must be an absolute path: ${value}`)
  }
}

class PiProvider implements SubagentProvider {
  readonly name = 'pi'
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    const spec: PiRunSpec = {
      cwd: resolveChildCwd(
        'subagent-pi',
        undefined,
        parentCwd,
      ),
      env: {
        ...this.config.env,
        ...(this.config.agentDir === undefined ? {} : { PI_CODING_AGENT_DIR: this.config.agentDir }),
        ...(this.config.sessionDir === undefined ? {} : { PI_CODING_AGENT_SESSION_DIR: this.config.sessionDir }),
      },
      command: this.config.command,
      args: this.config.args,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-pi: child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startPiRun(request, spec)
  }
}

/**
 * Register the fixed `pi` provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - child environment, process-release bounds, and Pi directories.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite(
    'subagent-pi',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  assertPositiveFinite(
    'subagent-pi',
    'disposeEofGraceMs',
    resolved.disposeEofGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-pi: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (resolved.disposeEofGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-pi: disposeEofGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  assertAbsoluteDir('subagent-pi', 'agentDir', resolved.agentDir)
  assertAbsoluteDir('subagent-pi', 'sessionDir', resolved.sessionDir)
  ctx.subagents.registerProvider(new PiProvider(ctx, resolved))
}
