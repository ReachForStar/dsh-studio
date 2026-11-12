/**
 * Arena: run one prompt through several models in parallel, each in its own
 * worktree, then hand the caller comparable results and apply one winner.
 *
 * Every contender gets an ordinary Session whose working directory is its own
 * checkout, so the comparison measures the models rather than their ability to
 * share a tree. Comparison data accumulates from delivered `session/event`
 * messages; no historical read is involved. Applying a winner is an explicit
 * second call, so an Arena run never writes the main checkout on its own.
 *
 * @module @deepseek-ai/dsh-arena
 */

import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { addWorktree, applyPatch, changedPaths, patchPathOf, removeWorktree, runGit, writePatch } from './git.ts'
import type { ArenaWorktree, GitLimits } from './git.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Comparison prompt one Arena contender receives. */
    'dsh-arena': { kind: 'dsh-arena' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    arena: ArenaService
  }
}

/** One model compared by an Arena run. */
export interface ArenaContender {
  /** Label unique within the run; it names the worktree, branch, and Session. */
  readonly label: string
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Optional positive output-token cap. */
  readonly maxTokens?: number
}

/** One comparison request. */
export interface ArenaRunRequest {
  /** Non-empty prompt every contender receives verbatim. */
  readonly prompt: string
  /** At least one contender; each runs concurrently in its own checkout. */
  readonly contenders: readonly ArenaContender[]
  /** Local commit to branch from; defaults to the repository's `HEAD`. */
  readonly from?: string
}

/** Per-contender outcome of one comparison. */
export interface ArenaContenderResult {
  /** Label from the request. */
  readonly label: string
  /** Provider route used for this contender. */
  readonly provider: string
  /** Provider-owned model id used for this contender. */
  readonly model: string
  /** Session that ran the contender; its log holds the full transcript. */
  readonly sessionId: SessionId
  /** Branch created for the contender. */
  readonly branch: string
  /** Absolute contender checkout path. */
  readonly worktree: string
  /** Whether the contender reached quiescence without an operational failure. */
  readonly status: 'completed' | 'failed' | 'cancelled'
  /** Failure text when `status` is not `completed`. */
  readonly failure?: string
  /** Final assistant text the contender produced, empty when it produced none. */
  readonly reply: string
  /** Wall-clock milliseconds from prompt admission to quiescence. */
  readonly durationMs: number
  /** Turns the contender ran. */
  readonly turns: number
  /** Tool calls the contender requested. */
  readonly toolCalls: number
  /** Total tokens the adapter reported; 0 when it reported none. */
  readonly tokens: number
  /** Paths the contender changed relative to the base commit, sorted. */
  readonly changedPaths: string[]
}

/** Complete outcome of one comparison. */
export interface ArenaRun {
  /** Stable identity of this comparison. */
  readonly runId: string
  /** Commit every contender branched from. */
  readonly baseCommit: string
  /** Prompt every contender received. */
  readonly prompt: string
  /** Unix epoch milliseconds when the run started. */
  readonly startedAt: number
  /** Contender outcomes in request order. */
  readonly contenders: readonly ArenaContenderResult[]
}

/** Arena service configuration. */
export interface Config {
  /** Absolute repository checkout the run branches from and applies winners to. */
  workspaceRoot: string
  /** Absolute directory holding one subdirectory per run; it must live outside `workspaceRoot`. */
  worktreeRoot: string
  /** Largest accepted number of contenders in one run. */
  maxContenders: number
  /** Deadline for one git command in milliseconds. */
  timeoutMs: number
  /** Termination grace period for one git command in milliseconds. */
  graceMs: number
  /** Maximum captured bytes per git output stream. */
  maxOutputBytes: number
}

/** Arena configuration schema. */
export const Config: z<Config> = z.object({
  workspaceRoot: z.string().required(),
  worktreeRoot: z.string().required(),
  maxContenders: z.number().step(1).min(1).default(4),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  graceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(3_000),
  maxOutputBytes: z.number().step(1).min(1).default(1_048_576),
})

/** Retention record for one run, kept so a later call can apply or remove it. */
interface RetentionRecord {
  readonly run: ArenaRun
  readonly directory: string
  readonly worktrees: readonly ArenaWorktree[]
  readonly controller: AbortController
}

/** Comparison data accumulated from delivered events for one contender. */
interface ContenderMetrics {
  turns: number
  toolCalls: number
  tokens: number
  reply: string
}

/** Require one non-empty trimmed string. */
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`arena: ${field} must be a non-empty string`)
  }
  return value.trim()
}

/** Keep a label usable as a branch, directory, and Session-id component. */
function safeLabel(label: string): string {
  const normalized = label.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (normalized.length === 0) throw new TypeError(`arena: contender label ${JSON.stringify(label)} has no usable characters`)
  return normalized
}

/** Validate and detach one run request. */
function resolveRequest(request: ArenaRunRequest, maxContenders: number): ArenaRunRequest {
  const candidate: unknown = request
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('arena: run request must be an object')
  }
  const record = candidate as Record<string, unknown>
  const contenders = record['contenders']
  if (!Array.isArray(contenders) || contenders.length === 0) {
    throw new TypeError('arena: run request requires at least one contender')
  }
  if (contenders.length > maxContenders) {
    throw new TypeError(`arena: run request has ${String(contenders.length)} contenders, above maxContenders ${String(maxContenders)}`)
  }
  const labels = new Set<string>()
  const resolved = contenders.map((entry: unknown, index: number) => {
    const item: unknown = entry
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`arena: contender ${String(index)} must be an object`)
    }
    const fields = item as Record<string, unknown>
    const label = safeLabel(requiredText(fields['label'], `contender ${String(index)} label`))
    if (labels.has(label)) throw new TypeError(`arena: contender label "${label}" is duplicated`)
    labels.add(label)
    const maxTokens = fields['maxTokens']
    if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
      throw new TypeError(`arena: contender "${label}" maxTokens must be a positive safe integer`)
    }
    return {
      label,
      provider: requiredText(fields['provider'], `contender "${label}" provider`),
      model: requiredText(fields['model'], `contender "${label}" model`),
      ...maxTokens === undefined ? {} : { maxTokens },
    }
  })
  const from = record['from']
  return {
    prompt: requiredText(record['prompt'], 'run request prompt'),
    contenders: resolved,
    ...from === undefined ? {} : { from: requiredText(from, 'run request from') },
  }
}

/** Text blocks of one assistant message, joined. */
function assistantText(event: { data: { message: { content: readonly ContentBlock[] } } }): string {
  return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
}

/**
 * Compare several models on one prompt and return their outcomes.
 *
 * Each contender runs concurrently in its own checkout. The run never writes
 * `workspaceRoot`: {@link ArenaService.apply} does that as an explicit,
 * separate choice.
 */
export class ArenaService extends Service {
  static inject = ['agents', 'fs', 'sandbox', 'sandboxPolicy', 'subprocess']

  /** Loader schema for this service. */
  static Config = Config

  private readonly config: Required<Config>
  private readonly records = new Map<string, RetentionRecord>()
  /** Comparison data for every contender currently running, keyed by Session id. */
  private readonly active = new Map<string, ContenderMetrics>()
  private sequence = 0

  /**
   * @param ctx - context exposing Agent, filesystem, sandbox, and subprocess capabilities.
   * @param config - resolved Arena configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'arena')
    this.config = config
    for (const [key, root] of [['workspaceRoot', config.workspaceRoot], ['worktreeRoot', config.worktreeRoot]] as const) {
      if (!isAbsolute(root)) throw new Error(`arena: ${key} must be an absolute path`)
    }
    const nested = relative(resolve(config.workspaceRoot), resolve(config.worktreeRoot))
    if (!nested.startsWith('..') && !isAbsolute(nested)) {
      throw new Error('arena: worktreeRoot must live outside workspaceRoot')
    }
    ctx.effect(() => () => {
      for (const record of this.records.values()) {
        record.controller.abort(new Error('arena disposed'))
      }
      this.records.clear()
    }, 'arena.runs')
    ctx.on('session/event', (session, event) => {
      const metrics = this.active.get(String(session.id))
      if (metrics === undefined) return
      switch (event.type) {
        case 'turn/start': metrics.turns += 1; return
        case 'tool/call': metrics.toolCalls += 1; return
        case 'assistant/message': {
          if (event.data.usage !== undefined) {
            metrics.tokens += event.data.usage.totalTokens
              ?? event.data.usage.inputTokens + event.data.usage.outputTokens
          }
          const text = assistantText(event)
          if (text.length > 0) metrics.reply = text
          return
        }
        default: return
      }
    })
  }

  /** Git limits derived from the configuration. */
  private get limits(): GitLimits {
    return {
      timeoutMs: this.config.timeoutMs,
      graceMs: this.config.graceMs,
      maxOutputBytes: this.config.maxOutputBytes,
    }
  }

  /**
   * Run one prompt through every contender concurrently.
   * @param request - prompt, contenders, and optional base commit.
   * @param options - cancellation for the whole comparison.
   * @returns every contender's outcome, in request order.
   * @throws {Error} when the request is malformed, the repository cannot be read, or the run is cancelled before settlement.
   */
  async run(request: ArenaRunRequest, options: { readonly signal?: AbortSignal } = {}): Promise<ArenaRun> {
    const resolved = resolveRequest(request, this.config.maxContenders)
    const controller = new AbortController()
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal])
    const policy = this.ctx.sandboxPolicy.resolve()
    const baseCommit = await runGit(
      this.ctx, this.limits, policy, this.config.workspaceRoot,
      ['rev-parse', resolved.from ?? 'HEAD'], signal,
    )
    this.sequence += 1
    const runId = `arena-${String(Date.now())}-${String(this.sequence)}`
    const directory = join(this.config.worktreeRoot, runId)
    const startedAt = Date.now()

    const settlement = await Promise.all(resolved.contenders.map(async (contender, index) => {
      const worktree: ArenaWorktree = {
        path: join(directory, `${String(index)}-${contender.label}`),
        branch: `arena/${runId}/${contender.label}`,
      }
      return this.settle(policy, runId, baseCommit, startedAt, worktree, contender, resolved.prompt, signal)
    }))
    const contenders = settlement.map(entry => entry.result)
    for (const entry of settlement) {
      if (entry.handle === undefined) continue
      try {
        await entry.handle.dispose()
      } catch (error: unknown) {
        this.ctx.logger.warn(`arena: contender "${entry.result.label}" dispose failed: ${String(error)}`)
      }
    }
    const run: ArenaRun = { runId, baseCommit, prompt: resolved.prompt, startedAt, contenders }
    this.records.set(runId, { run, directory, worktrees: settlement.map(entry => entry.worktree), controller })
    return run
  }

  /** Run one contender end to end and collect its outcome. */
  private async settle(
    policy: SandboxExecutionPolicy,
    runId: string,
    baseCommit: string,
    runStartedAt: number,
    worktree: ArenaWorktree,
    contender: ArenaContender,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ result: ArenaContenderResult; worktree: ArenaWorktree; handle?: AgentHandle }> {
    const sessionId = brandString<SessionId>(`arena-${runId}-${contender.label}`)
    const failed = (failure: string, extra: Partial<ArenaContenderResult> = {}): ArenaContenderResult => ({
      label: contender.label,
      provider: contender.provider,
      model: contender.model,
      sessionId,
      branch: worktree.branch,
      worktree: worktree.path,
      status: signal.aborted ? 'cancelled' : 'failed',
      failure,
      reply: '',
      durationMs: Date.now() - runStartedAt,
      turns: 0,
      toolCalls: 0,
      tokens: 0,
      changedPaths: [],
      ...extra,
    })
    let handle: AgentHandle | undefined
    try {
      await addWorktree(this.ctx, this.limits, policy, this.config.workspaceRoot, worktree, baseCommit, signal)
      const metrics: ContenderMetrics = { turns: 0, toolCalls: 0, tokens: 0, reply: '' }
      this.active.set(String(sessionId), metrics)
      const agentOptions: AgentOptions = {
        provider: contender.provider,
        model: contender.model,
        ...contender.maxTokens === undefined ? {} : { maxTokens: contender.maxTokens },
      }
      handle = await this.ctx.agents.create({
        sessionId,
        signal,
        meta: { cwd: worktree.path },
        agentOptions,
      })
      const startedAt = Date.now()
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: {
          kind: 'dsh-arena',
          form: 'notice',
          summary: boundContextSummary(`arena ${runId} contender ${contender.label}`),
        },
      }))
      await handle.agent.whenIdle()
      signal.throwIfAborted()
      const result: ArenaContenderResult = {
        label: contender.label,
        provider: contender.provider,
        model: contender.model,
        sessionId,
        branch: worktree.branch,
        worktree: worktree.path,
        status: 'completed',
        reply: metrics.reply,
        durationMs: Date.now() - startedAt,
        turns: metrics.turns,
        toolCalls: metrics.toolCalls,
        tokens: metrics.tokens,
        changedPaths: await changedPaths(this.ctx, this.limits, policy, worktree.path, baseCommit, signal),
      }
      return { result, worktree, handle }
    } catch (error: unknown) {
      const failure = error instanceof Error ? error.message : String(error)
      if (handle !== undefined) {
        try {
          await handle.dispose()
        } catch (disposeError: unknown) {
          this.ctx.logger.warn(`arena: contender "${contender.label}" cleanup failed: ${String(disposeError)}`)
        }
      }
      return { result: failed(failure), worktree }
    } finally {
      this.active.delete(String(sessionId))
    }
  }

  /**
   * Apply one contender's changes to the configured workspace root.
   * @param runId - run identity returned by {@link ArenaService.run}.
   * @param label - contender whose checkout supplies the diff.
   * @param options - cancellation for the git operations.
   * @returns paths the applied diff touched.
   * @throws {Error} when the run or contender is unknown, or the patch does not apply.
   */
  async apply(runId: string, label: string, options: { readonly signal?: AbortSignal } = {}): Promise<string[]> {
    const record = this.records.get(runId)
    if (record === undefined) throw new Error(`arena: unknown run "${runId}"`)
    const index = record.run.contenders.findIndex(contender => contender.label === label)
    const contender = record.run.contenders[index]
    const worktree = record.worktrees[index]
    if (contender === undefined || worktree === undefined) throw new Error(`arena: run "${runId}" has no contender "${label}"`)
    if (contender.changedPaths.length === 0) return []
    const signal = options.signal ?? new AbortController().signal
    const policy = this.ctx.sandboxPolicy.resolve()
    const patchPath = patchPathOf(record.directory)
    await writePatch(
      this.ctx, this.limits, policy, worktree.path, record.run.baseCommit, patchPath, signal,
    )
    await applyPatch(this.ctx, this.limits, policy, this.config.workspaceRoot, patchPath, signal)
    return [...contender.changedPaths]
  }

  /**
   * Remove one run's checkouts and branches.
   * @param runId - run identity returned by {@link ArenaService.run}.
   * @param options - cancellation for the git operations.
   * @throws {Error} when the run is unknown.
   */
  async remove(runId: string, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const record = this.records.get(runId)
    if (record === undefined) throw new Error(`arena: unknown run "${runId}"`)
    const signal = options.signal ?? new AbortController().signal
    const policy = this.ctx.sandboxPolicy.resolve()
    for (const worktree of record.worktrees) {
      try {
        await removeWorktree(this.ctx, this.limits, policy, this.config.workspaceRoot, worktree, signal)
      } catch (error: unknown) {
        this.ctx.logger.warn(`arena: run "${runId}" could not remove ${worktree.path}: ${String(error)}`)
      }
    }
    this.records.delete(runId)
  }

  /**
   * List the runs this service still retains.
   * @returns the retained runs, oldest first.
   */
  runs(): readonly ArenaRun[] {
    return [...this.records.values()].map(record => record.run)
  }
}

export default ArenaService
