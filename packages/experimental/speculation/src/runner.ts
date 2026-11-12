/**
 * Speculation runner: predicts the next user request after a turn ends, gates
 * the predicted tool calls, and pre-executes them so an accepted prediction
 * already carries its work.
 *
 * Predicted writes never reach the workspace during prediction: the gate
 * rewrites their path arguments into the overlay tree, and the real tools write
 * there. The overlay content reaches the workspace only when the user's next
 * message matches the prediction and the policy allows writes.
 *
 * @module @deepseek-ai/dsh-speculation/runner
 */

import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as json } from 'zod'
import { BlockAssembler, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, Message, ToolCallBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session/types'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { accumulateTurn, boundUtf8 } from '@deepseek-ai/dsh-followup'
import type { TurnExcerpt } from '@deepseek-ai/dsh-followup'
import { commitOverlay, discardOverlay, seedOverlay } from './overlay.ts'
import type { OverlayWrite } from './overlay.ts'
import { Config as GateConfig, gatePlan, resolvePolicy, rewriteArguments } from './index.ts'
import type { Config as GateConfigShape, SpeculationDecision, SpeculationStep } from './index.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'speculation': true
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Auxiliary next-request prediction requests this package issues. */
    'dsh-speculation': { kind: 'dsh-speculation' } & ContextFormed
  }
}

/** What became of one predicted tool call. */
export type SpeculationStepStatus = 'read' | 'overlay-write' | 'failed' | 'boundary'

/** One predicted tool call and its outcome. */
export interface SpeculationStepRecord {
  /** Tool name the prediction asked for. */
  tool: string
  /** Whether the call ran unchanged, wrote into the overlay, failed, or stopped the plan. */
  status: SpeculationStepStatus
}

/** Log-only record of one completed prediction. */
export interface SpeculationProposalEventData {
  /** Turn whose completion produced the prediction. */
  turn: number
  /** Predicted next request text, as the model returned it. */
  predictedRequest: string
  /** Predicted calls in model order, ending at the boundary that stopped the plan. */
  steps: SpeculationStepRecord[]
}

/** Log-only record of how a prediction ended. */
export interface SpeculationOutcomeEventData {
  /** Turn whose prediction was settled. */
  turn: number
  /** Whether the prediction was accepted into the workspace or dropped. */
  decision: 'commit' | 'discard'
  /** Workspace paths the commit wrote, or overlay paths the discard removed. */
  paths: string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Latest-wins prediction for one completed turn. It is log-only
     * presentation data: it never enters the model surface or derived history.
     */
    'speculation/proposal': SpeculationProposalEventData
    /** Log-only settlement of one prediction; it never enters the model surface. */
    'speculation/outcome': SpeculationOutcomeEventData
  }
}

/** Terminal reason code for a prediction request over deadline. */
export const SPECULATION_TIMEOUT_CODE = 'SPECULATION_TIMEOUT'

/** Instruction the runner sends with every prediction request. */
export const SPECULATION_SYSTEM_PROMPT = 'You predict the next user request of a coding agent session and the tool '
  + 'calls that would pre-compute it. Reply with one JSON object and nothing else: '
  + '{"request": string, "steps": [{"tool": string, "arguments": object}]}. Use only the listed tools.'

/** Runner configuration: the speculation policy plus the prediction request controls. */
export interface Config extends GateConfigShape {
  /** Optional explicit prediction route; must be paired with `model`. */
  provider?: string
  /** Optional explicit prediction model; must be paired with `provider`. */
  model?: string
  /** Maximum UTF-8 bytes in the prepared prediction input. */
  maxInputBytes: number
  /** Output-token cap for one prediction request. */
  maxOutputTokens: number
  /** End-to-end prediction deadline in milliseconds. */
  timeoutMs: number
  /** Maximum predicted tool calls to execute. */
  maxSteps: number
  /** Maximum characters kept from the predicted request. */
  maxRequestChars: number
}

/** Runner configuration schema: the gate policy plus the prediction request controls. */
export const Config: z<Config> = z.intersect([GateConfig, z.object({
  provider: z.string(),
  model: z.string(),
  maxInputBytes: z.number().step(1).min(1).default(8_192),
  maxOutputTokens: z.number().step(1).min(1).default(512),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(20_000),
  maxSteps: z.number().step(1).min(1).default(4),
  maxRequestChars: z.number().step(1).min(1).default(200),
})])

/** One parsed prediction: the request text and the calls that would pre-compute it. */
export interface SpeculationPlan {
  /** Predicted next request text. */
  request: string
  /** Predicted calls in model order, before gating. */
  steps: SpeculationStep[]
}

/** Shape one model forecast must satisfy before any predicted call runs. */
const PLAN_SCHEMA = json.object({
  request: json.string(),
  steps: json.array(json.object({
    tool: json.string(),
    arguments: json.record(json.string(), json.unknown()).default({}),
  })).default([]),
})

/**
 * Render the prediction request's user input.
 * @param excerpt - turn text the prediction is based on.
 * @param tools - tool schemas the prediction may call.
 * @param maxInputBytes - UTF-8 byte cap on the rendered input.
 * @param maxSteps - largest accepted number of predicted calls, stated to the model.
 * @returns the framed input text, truncated when over the cap.
 */
export function renderPlanInput(
  excerpt: TurnExcerpt,
  tools: readonly ToolSchema[],
  maxInputBytes: number,
  maxSteps: number,
): string {
  const sections = [
    `Pre-execute the user's most likely next request with at most ${String(maxSteps)} tool calls; `
    + 'reply with an empty step list when no tool helps.',
  ]
  if (excerpt.request !== undefined) sections.push(`User's last request:\n${excerpt.request}`)
  if (excerpt.reply !== undefined) sections.push(`Assistant's last reply:\n${excerpt.reply}`)
  sections.push(`Tools you may call:\n${JSON.stringify(tools)}`)
  return boundUtf8(sections.join('\n\n'), maxInputBytes)
}

/**
 * Parse one model forecast into a plan.
 * @param text - assembled model output, optionally wrapped in a code fence.
 * @param maxSteps - largest accepted number of predicted calls.
 * @returns the prediction with its request trimmed and at most `maxSteps` calls.
 * @throws {Error} when the output is not a JSON object matching the plan schema, or names no request.
 */
export function parsePlan(text: string, maxSteps: number): SpeculationPlan {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('speculation: the forecast is not a JSON object')
  const parsed: unknown = JSON.parse(text.slice(start, end + 1))
  const forecast = PLAN_SCHEMA.safeParse(parsed)
  if (!forecast.success) {
    const issues = forecast.error.issues.map(issue => issue.message).join('; ')
    throw new Error(`speculation: the forecast does not match the plan schema: ${issues}`)
  }
  const request = forecast.data.request.trim()
  if (request.length === 0) throw new Error('speculation: the forecast named no request')
  return {
    request,
    steps: forecast.data.steps.slice(0, maxSteps).map(step => ({ tool: step.tool, args: step.arguments })),
  }
}

/**
 * Decide whether a user message confirms a prediction.
 * @param predicted - request text the forecast named.
 * @param actual - text of the user message that arrived.
 * @returns whether both normalize to the same non-empty text.
 */
export function matchesPrediction(predicted: string, actual: string): boolean {
  const normalize = (text: string): string => text.trim().replace(/\s+/gu, ' ').toLowerCase()
  const target = normalize(actual)
  return target.length > 0 && target === normalize(predicted)
}

/**
 * Pair one gate redirect with the workspace file it mirrors.
 * @param config - policy providing both roots.
 * @param decision - redirect decision carrying the overlay path.
 * @returns the overlay copy and the workspace file it mirrors.
 */
function overlayWrite(
  config: Config,
  decision: Extract<SpeculationDecision, { action: 'redirect' }>,
): OverlayWrite {
  const suffix = relative(resolve(config.overlayRoot), decision.redirectPath)
  return {
    overlay: decision.redirectPath,
    workspace: join(resolve(config.workspaceRoot), suffix),
  }
}

/**
 * Collect the tool schemas a prediction may call.
 * @param ctx - context exposing the tool registry.
 * @param config - policy naming the classified tools.
 * @returns schemas of the read-only tools, plus the write tools when writes are allowed.
 */
function planCatalogue(ctx: Context, config: Config): ToolSchema[] {
  const policy = resolvePolicy(config)
  const names = new Set(policy.readOnlyTools)
  if (config.allowWrites) for (const name of policy.writeTools) names.add(name)
  return ctx.tools.schemas().filter(schema => names.has(schema.name))
}

/**
 * Request one forecast from the auxiliary route.
 * @param ctx - context exposing the LLM service.
 * @param session - session whose turn completed.
 * @param config - validated runner configuration.
 * @param tools - schemas the forecast may call.
 * @param excerpt - turn text the prediction is based on.
 * @param signal - aborts the request.
 * @returns the parsed prediction.
 * @throws {Error} when the route is unconfigured, the deadline passes, or the forecast is unusable.
 */
export async function requestPlan(
  ctx: Context,
  session: Session,
  config: Config,
  tools: readonly ToolSchema[],
  excerpt: TurnExcerpt,
  signal: AbortSignal,
): Promise<SpeculationPlan> {
  if (config.provider === undefined || config.model === undefined) {
    throw new Error('speculation: provider and model must be configured together')
  }
  const input = renderPlanInput(excerpt, tools, config.maxInputBytes, config.maxSteps)
  using callDeadline = deadline(signal, config.timeoutMs, SPECULATION_TIMEOUT_CODE)
  const maxTokens = config.maxOutputTokens
  const call = await ctx.llm.prepareCall(
    { provider: config.provider, model: config.model, maxTokens },
    callDeadline.signal,
  )
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: 'dsh-speculation' },
  })]
  const assembler = new BlockAssembler()
  for await (const chunk of call.stream({
    ...call.config,
    messages,
    system: SPECULATION_SYSTEM_PROMPT,
    sessionId: session.id,
    purpose: 'speculation',
    signal: callDeadline.signal,
  })) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  const text = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  return parsePlan(text, config.maxSteps)
}

/** One prediction run kept until the user's next message settles it. */
interface ActiveRun {
  readonly turn: number
  readonly controller: AbortController
  /** Overlay copies produced so far; partial progress is discarded on abandonment. */
  readonly writes: OverlayWrite[]
  /** Predicted request, set once the plan finished; absent while it still runs. */
  predicted: string | undefined
}

/** Per-session accumulation state; no historical read is needed. */
interface SessionState {
  readonly turns: Map<number, TurnExcerpt>
  readonly predictedTurns: Set<number>
  openTurn: number | undefined
  run: ActiveRun | undefined
}

/**
 * Execute the gated plan, one call at a time.
 *
 * Redirected calls write into the overlay through their rewritten path
 * argument, so the tools themselves stay unaware of the speculation.
 * @param ctx - context exposing the tool registry and the filesystem.
 * @param config - policy providing both roots.
 * @param plan - parsed prediction.
 * @param callPrefix - stable call-id prefix for correlation.
 * @param signal - aborts the plan between calls.
 * @param writes - collector receiving each produced overlay copy as it appears.
 * @returns the per-call records in model order, ending at the boundary that stopped the plan.
 */
export async function executePlan(
  ctx: Context,
  config: Config,
  plan: SpeculationPlan,
  callPrefix: string,
  signal: AbortSignal,
  writes: OverlayWrite[],
): Promise<SpeculationStepRecord[]> {
  const gated = gatePlan(plan.steps, config)
  const steps: SpeculationStepRecord[] = []
  for (const [index, entry] of gated.allowed.entries()) {
    signal.throwIfAborted()
    const args = rewriteArguments(entry.step.args, entry.decision)
    const write = entry.decision.action === 'redirect' ? overlayWrite(config, entry.decision) : undefined
    if (write !== undefined) await seedOverlay(ctx.fs, write, signal)
    const calls: ToolCallBlock[] = [{
      type: 'tool-call',
      id: ToolCallId(`${callPrefix}-${String(index)}`),
      name: entry.step.tool,
      arguments: JSON.stringify(args),
    }]
    const batch = await ctx.tools.execute({ calls, signal })
    const failed = batch.results[0]?.result.isError ?? true
    if (failed) {
      steps.push({ tool: entry.step.tool, status: 'failed' })
      continue
    }
    if (write !== undefined) writes.push(write)
    steps.push({ tool: entry.step.tool, status: write === undefined ? 'read' : 'overlay-write' })
  }
  if (gated.stopped !== undefined) steps.push({ tool: gated.stopped.tool, status: 'boundary' })
  return steps
}

/**
 * Read the text one user message carries.
 * @param content - message content blocks.
 * @returns the joined text blocks, trimmed.
 */
function userText(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ').trim()
}

/**
 * Drop the run's overlay copies, reporting a failure without masking the cause.
 * @param ctx - context exposing the filesystem and the logger.
 * @param run - run being abandoned.
 */
async function abandon(ctx: Context, run: ActiveRun): Promise<void> {
  try {
    await discardOverlay(ctx.fs, run.writes)
  } catch (error) {
    ctx.logger.warn(`speculation: turn ${String(run.turn)} left overlay files behind: ${String(error)}`)
  }
}

/**
 * Run one prediction to completion and log it.
 * @param ctx - context exposing the LLM, tools, and filesystem services.
 * @param config - validated runner configuration.
 * @param session - session whose turn completed.
 * @param run - run record settled by the next user message.
 * @param excerpt - turn text the prediction is based on.
 */
async function runPrediction(
  ctx: Context,
  config: Config,
  session: Session,
  run: ActiveRun,
  excerpt: TurnExcerpt,
): Promise<void> {
  try {
    const plan = await requestPlan(ctx, session, config, planCatalogue(ctx, config), excerpt, run.controller.signal)
    const steps = await executePlan(
      ctx, config, plan, `${session.id}-${String(run.turn)}`, run.controller.signal, run.writes,
    )
    run.predicted = plan.request.slice(0, config.maxRequestChars)
    session.append('speculation/proposal', {
      turn: run.turn,
      predictedRequest: run.predicted,
      steps,
    })
  } catch (error) {
    await abandon(ctx, run)
    if (!run.controller.signal.aborted) {
      ctx.logger.warn(`speculation: turn ${String(run.turn)} produced no prediction: ${String(error)}`)
    }
  }
}

/**
 * Apply one prediction once the user's next message arrives.
 * @param ctx - context exposing the filesystem.
 * @param session - session the prediction belongs to.
 * @param config - validated runner configuration.
 * @param run - completed run being settled.
 * @param actual - text of the user message that arrived.
 */
async function settle(
  ctx: Context,
  session: Session,
  config: Config,
  run: ActiveRun,
  actual: string,
): Promise<void> {
  const confirmed = config.allowWrites && run.predicted !== undefined
    && matchesPrediction(run.predicted, actual)
  try {
    const paths = confirmed
      ? await commitOverlay(ctx.fs, run.writes)
      : await discardOverlay(ctx.fs, run.writes)
    session.append('speculation/outcome', {
      turn: run.turn,
      decision: confirmed ? 'commit' : 'discard',
      paths,
    })
  } catch (error) {
    ctx.logger.warn(`speculation: turn ${String(run.turn)} could not be settled: ${String(error)}`)
  }
}

/** Plugin name used by loader diagnostics. */
export const name = 'speculation'

/** Services the runner reads. */
export const inject = ['llm', 'tools', 'fs']

/**
 * Mount the speculation runner.
 * @param ctx - plugin context.
 * @param config - validated runner configuration.
 * @throws {Error} when the route, the roots, or the overlay placement is unusable.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.provider === undefined || config.model === undefined) {
    throw new Error('speculation: provider and model must be configured together')
  }
  for (const [key, root] of [['workspaceRoot', config.workspaceRoot], ['overlayRoot', config.overlayRoot]] as const) {
    if (!isAbsolute(root)) throw new Error(`speculation: ${key} must be an absolute path`)
  }
  const inside = relative(resolve(config.workspaceRoot), resolve(config.overlayRoot))
  if (!inside.startsWith('..') && !isAbsolute(inside)) {
    throw new Error('speculation: overlayRoot must live outside workspaceRoot')
  }
  const states = new WeakMap<Session, SessionState>()
  const runs = new Set<ActiveRun>()

  ctx.effect(() => () => {
    for (const run of runs) {
      run.controller.abort(new Error('speculation disposed'))
      void abandon(ctx, run)
    }
    runs.clear()
  }, 'speculation.runs')

  const stateOf = (session: Session): SessionState => {
    const existing = states.get(session)
    if (existing !== undefined) return existing
    const created: SessionState = { turns: new Map(), predictedTurns: new Set(), openTurn: undefined, run: undefined }
    states.set(session, created)
    return created
  }

  const start = (session: Session, state: SessionState, excerpt: TurnExcerpt, turn: number): void => {
    const run: ActiveRun = {
      turn,
      controller: new AbortController(),
      writes: [],
      predicted: undefined,
    }
    state.run = run
    runs.add(run)
    void runPrediction(ctx, config, session, run, excerpt).finally(() => { runs.delete(run) })
  }

  ctx.on('session/event', (session, event) => {
    const state = stateOf(session)
    if (event.type === 'turn/start') {
      state.openTurn = event.data.turn
      return
    }
    if (event.type === 'turn/end') {
      const turn = event.data.turn
      const excerpt = state.turns.get(turn)
      state.turns.delete(turn)
      if (excerpt !== undefined && !state.predictedTurns.has(turn)) {
        state.predictedTurns.add(turn)
        start(session, state, excerpt, turn)
      }
      return
    }
    if (event.type === 'user/message') {
      const run = state.run
      state.run = undefined
      if (run !== undefined) {
        if (run.predicted === undefined) run.controller.abort(new Error('speculation superseded by user input'))
        else void settle(ctx, session, config, run, userText(event.data.content))
      }
    }
    accumulateTurn(state.turns, state.openTurn, event)
  })
}
