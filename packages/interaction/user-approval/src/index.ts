/**
 * Service Definition for the approval capability seam, covering requests, cancellation, audit, and per-session policy. Missing
 * answerers fail closed; grants apply only to the requested action.
 * @module @deepseek-ai/dsh-user-approval
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'user-approval': { kind: 'user-approval' } & ContextFormed
  }
}

import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { projectApprovalRulesSpec } from './project-rules.ts'
import type { ProjectApprovalRules } from './project-rules.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    approval: ApprovalService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's approval policy was switched — log-only, durable,
     * replayable, never in the model transcript (the model learns the policy
     * from the runtime-context snapshot and live switch notices). The LAST
     * such event is the session's override.
     * `source: 'delegation'` marks an override seeded into a child; an absent
     * source is a runtime switch.
     */
    'approval/policy': {
      policy: ApprovalPolicy
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
  }
}

import { ApprovalRequestId } from './types.ts'
import type { ApprovalOutcome, ApprovalRequestEvent } from './types.ts'
import { evaluateApprovalRules, splitCommandWords } from './rules.ts'
import type { ApprovalRule, ApprovalRuleMatch } from './rules.ts'

export { ApprovalRequestId } from './types.ts'
export type { ApprovalOutcome } from './types.ts'
export {
  evaluateApprovalRules,
  matchApprovalPattern,
} from './rules.ts'
export type { ApprovalRule, ApprovalRuleEffect, ApprovalRuleMatch, ApprovalRuleRequest } from './rules.ts'

/** Every {@link ApprovalOutcome}, for runtime normalization of answerer returns. */
const OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable', 'timed-out']

/**
 * A session's approval policy — what happens to an {@link ApprovalService}
 * ask BEFORE any interactive answerer sees it:
 *
 * - `'ask'` (the default) — delegate to the composed answerers; with none
 *   composed the chain falls through to the fail-closed `'unavailable'`.
 * - `'never'` — never prompt anyone: every ask resolves `'rejected'`
 *   deterministically. The strict headless stance (CI, unattended runs) and
 *   the policy whose outcome is knowable without asking.
 */
export type ApprovalPolicy = 'ask' | 'never'

/** Every {@link ApprovalPolicy}, for option advertisement and runtime validation of untrusted policy strings. */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['ask', 'never']

/** Model-facing statement for the deterministic `'never'` policy. */
const NEVER_SENTENCE = 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
/** Model-facing statement for an interactive policy that may still fail closed. */
const ASK_SENTENCE = 'Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'
/** Model-facing policy names in switch notices; a bare `never` reads as "approval is never granted". */
const POLICY_NOTICE_NAMES: Readonly<Record<ApprovalPolicy, string>> = {
  ask: 'ask the user for approval',
  never: 'never ask the user for approval',
}

interface ApprovalState {
  policy: ApprovalPolicy | null
  // Mirrors AgentRegistry's turn enclosure without requiring an agent registry.
  turnOpen: boolean
}

const approvalStateDefinition = {
  key: 'approvalState',
  stateVersion: 1,
  stateSchema: zod.object({
    policy: zod.enum(['ask', 'never']).nullable(),
    turnOpen: zod.boolean(),
  }),
  init: (): ApprovalState => ({ policy: null, turnOpen: false }),
  apply(state: ApprovalState, event: SessionEvent): ApprovalState {
    switch (event.type) {
      case 'approval/policy':
        return state.policy === event.data.policy ? state : { ...state, policy: event.data.policy }
      case 'turn/start':
        return state.turnOpen ? state : { ...state, turnOpen: true }
      case 'turn/end':
        return state.turnOpen ? { ...state, turnOpen: false } : state
      default:
        return state
    }
  },
} satisfies ProjectionDefinition<'approvalState', ApprovalState>

/**
 * Append the sole durable representation of a session policy override. Invalid
 * values throw before the log changes; projected state follows the committed record.
 * @param session - the session the override belongs to.
 * @param policy - the policy in effect until the next switch.
 */
export function setApprovalPolicy(session: Session, policy: ApprovalPolicy): void {
  if (!APPROVAL_POLICIES.includes(policy)) {
    throw new TypeError('approval policy must be one of "ask" or "never"')
  }
  session.append('approval/policy', { policy })
}

/**
 * Readonly same-process permission question. `callId` links to an already
 * presented tool call, so arguments are not duplicated here.
 */
export interface ApprovalRequest extends ApprovalRequestEvent {
  /**
   * The agent on whose behalf the question is asked. Routes the question (a
   * UI answerer only answers for agents it owns) and receives the audit
   * events on its session log.
   */
  readonly agent: Agent
  /** The tool the question is about (presentation and audit). */
  readonly toolName: string
  /**
   * The exact tool call being decided, when the asker has one — lets a UI
   * attach the prompt to the tool call it already streamed.
   */
  readonly callId?: ToolCallId
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /**
   * Aborting withdraws the question: the request settles `'cancelled'`
   * immediately and a late answer from a still-pending answerer is discarded.
   */
  readonly signal?: AbortSignal
}

/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * The deployment's default {@link ApprovalPolicy} for sessions without an
   * `approval/policy` override — `'ask'` delegates to the composed answerers
   * (fail-closed with none); `'never'` auto-rejects every ask without
   * prompting (the deterministic CI/unattended stance).
   */
  readonly policy?: ApprovalPolicy
  /**
   * Ordered `{action, resource, effect, match}` rules evaluated before the
   * policy and the answerers. Later matching rules override earlier ones; a
   * matching `'allow'` grants the request and a matching `'deny'` rejects it
   * even under the `'never'` policy, which is how unattended runs permit exact
   * actions. `match: 'prefix'` treats the resource as a literal command prefix
   * matched against whole command words.
   */
  readonly rules?: ApprovalRule[]
  /**
   * Maximum time one request may wait for an answerer, in milliseconds.
   * `0` (the default) waits until an answer or cancellation. On expiry the
   * request settles `'timed-out'`; a late answer is discarded.
   */
  readonly timeoutMs?: number
}

/**
 * Approval service that applies session policy before answerers and logs every
 * ask/outcome pair to the requesting session. It exposes deterministic policy
 * changes to the model through the runtime-context snapshot and switch notices.
 */
export class ApprovalService extends Service {
  static inject = ['sessionProjections']

  static Config: z<Config> = z.object({
    policy: z.union(['ask', 'never'] as const).default('ask'),
    rules: z.array(z.object({
      action: z.string(),
      resource: z.string(),
      effect: z.union(['allow', 'deny', 'ask'] as const),
      match: z.union(['glob', 'prefix'] as const).default('glob'),
    })).default([]),
    timeoutMs: z.number().min(0).default(0),
  })

  private approvalProjectionHandle!: ProjectionHandle<ApprovalState>
  private readonly rules: readonly ApprovalRule[]
  private projectRules: KvTable<string, ProjectApprovalRules> | undefined
  /**
   * Session-lifetime rules added through `/allow --session`. They live only in
   * memory so ending the Session drops them; a restart cannot resurrect them.
   */
  private readonly sessionRules = new WeakMap<Session, ApprovalRule[]>()
  /** Correction text recorded through `/correct`, keyed by session then tool call. */
  private readonly corrections = new WeakMap<Session, Map<ToolCallId, string>>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'approval')
    this.rules = config.rules ?? []
  }

  protected async [Service.init](): Promise<void> {
    this.approvalProjectionHandle = await this.ctx.sessionProjections.register(approvalStateDefinition)
    // Registration can finish after an unload has started. Do not add effects then.
    if (this.ctx.fiber.uid === null) return

    await this.ctx.inject(['commands'], (scope: Context) => {
      scope.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-user-approval'),
        name: 'allow',
        description: 'Add, list, or remove project or session approval rules',
        handler: invocation => this.allowCommand(invocation),
      })
      scope.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-user-approval'),
        name: 'correct',
        description: 'Reject a pending tool call with corrected arguments',
        handler: invocation => Promise.resolve(this.correctCommand(invocation)),
      })
    })

    const storageDomain = this.ctx.get('storageDomain')
    if (storageDomain !== undefined) {
      const domain = await storageDomain.open(projectApprovalRulesSpec)
      this.projectRules = domain.table('projects')
      this.ctx.effect(() => () => domain.close(), 'user-approval: project rules domain')
    }

    const effective = (agent: Agent): ApprovalPolicy => this.effectivePolicy(agent.session)

    // The complete current value travels after retained history, so switching
    // policy does not rewrite the stable system-prompt cache prefix.
    await this.ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'approval:policy',
        order: scope.systemPrompt.getContextOrder('APPROVAL_POLICY'),
        text: (context) => {
          const agent = context.agent
          // A bare assemble() (tests, diagnostics) has no session to state.
          if (agent === undefined) return ''
          const policy = effective(agent)
          return policy === 'never' ? NEVER_SENTENCE : ASK_SENTENCE
        },
      })
    })
  }

  /**
   * Switch one live agent's policy and queue the transition for its next model
   * step. Session initialization uses {@link setApprovalPolicy} directly
   * because there is no previously visible policy to change.
   * @param agent - the live agent whose policy is changing.
   * @param policy - the new effective policy.
   */
  setPolicy(agent: Agent, policy: ApprovalPolicy): void {
    const previous = this.effectivePolicy(agent.session)
    if (previous === policy) return
    setApprovalPolicy(agent.session, policy)
    agent.inject(createUserMessage({
      content: [{
        type: 'text',
        text: `The user changed the approval policy from "${POLICY_NOTICE_NAMES[previous]}" to "${POLICY_NOTICE_NAMES[policy]}".`,
      }],
      source: { kind: 'user-approval' },
    }))
  }

  /**
   * Ask the composed answerers to decide one readonly same-process request.
   * The service borrows the request, agent, session, and live signal directly.
   * The request requires an open turn because the audit pair must be enclosed
   * by the durable log's commit/replay boundary; an idle ask rejects before
   * appending anything. The answerer phase always produces an outcome: an
   * aborted signal yields `'cancelled'`, a missing or throwing answerer yields
   * `'unavailable'` (fail closed), and a rogue non-vocabulary return value is
   * normalized to `'unavailable'`. A failure that prevents either audit append
   * from committing still rejects because returning an unlogged decision would
   * violate the pair. Session contains post-commit observer failures, so an
   * authoritative append cannot reject the request or suppress its matching
   * audit event.
   * @param req - the pending decision (agent, tool identity, reason, signal).
   * @returns the closed outcome; `'allowed-once'` is the only grant.
   * @throws when no turn is open or either audit event fails before the session
   *   append commit point.
   */
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const session = req.agent.session
    if (!this.approvalStateOf(session).turnOpen) {
      throw new Error(
        'approval.request() outside an open turn: the approval/asked + approval/decided audit pair '
        + 'must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). '
        + 'Ask from inside the turn that needs the decision.',
      )
    }
    const id = ApprovalRequestId(randomUUID())
    session.append('approval/asked', {
      id,
      toolName: req.toolName,
      ...req.callId !== undefined ? { callId: req.callId } : {},
      ...req.reason !== undefined ? { reason: req.reason } : {},
    })
    const outcome = await this.decideWithRules(req, session)
    session.append('approval/decided', { id, outcome })
    return outcome
  }

  /**
   * Apply configured, project, and session rules before the session policy and
   * the answerers: a matching `'allow'` grants this request, a matching
   * `'deny'` rejects it even under the `'never'` policy, and `'ask'` or no
   * match continues to the ordinary decision path. Rules never carry a
   * wildcard grant beyond the request they matched, and a `needsHuman`
   * request turns a matching `'allow'` into a prompt because automation may
   * not substitute for the person.
   * @param req - the pending decision with its classified action and resources.
   * @param session - the request agent's session used for policy lookup.
   * @returns the closed outcome.
   */
  private decideWithRules(req: ApprovalRequest, session: Session): Promise<ApprovalOutcome> {
    const projectRules = this.projectRulesFor(session.header.cwd)
    const sessionRules = this.sessionRulesOf(session)
    const effect = evaluateApprovalRules([
      ...this.rules,
      ...projectRules,
      ...sessionRules,
    ], {
      action: req.action ?? req.toolName,
      resources: req.resources ?? [],
    })
    if (effect === 'deny') return Promise.resolve('rejected')
    if (effect === 'allow' && req.needsHuman !== true) return Promise.resolve('allowed-once')
    return this.decide(req, session)
  }

  /**
   * Read the rules stored for one project directory.
   * @param cwd - the session's recorded working directory.
   * @returns the stored rules, or none without a directory or storage.
   */
  projectRulesFor(cwd: string | undefined): readonly ApprovalRule[] {
    if (cwd === undefined) return []
    return this.projectRules?.get(cwd)?.rules ?? []
  }

  /**
   * Read the rules added to one Session's memory for its lifetime.
   * @param session - the session whose rules apply.
   * @returns the session's ordered rules.
   */
  sessionRulesFor(session: Session): readonly ApprovalRule[] {
    return this.sessionRulesOf(session)
  }

  /**
   * Append one in-memory rule to a Session. The rule is evaluated after
   * project rules and disappears with the Session; nothing is persisted.
   * @param session - the session receiving the rule.
   * @param rule - the rule to append.
   * @returns the session's complete rule list after the write.
   */
  addSessionRule(session: Session, rule: ApprovalRule): readonly ApprovalRule[] {
    assertRule(rule)
    const existing = this.sessionRulesOf(session)
    const rules = [...existing, rule]
    this.sessionRules.set(session, rules)
    return rules
  }

  /**
   * Remove one in-memory rule from a Session by position.
   * @param session - the session owning the rule.
   * @param index - the rule's position in {@link sessionRulesFor}.
   * @returns the removed rule, or `undefined` when the position does not exist.
   */
  removeSessionRule(session: Session, index: number): ApprovalRule | undefined {
    const existing = this.sessionRulesOf(session)
    const removed = existing[index]
    if (removed === undefined) return undefined
    this.sessionRules.set(session, existing.filter((_rule, position) => position !== index))
    return removed
  }

  private sessionRulesOf(session: Session): readonly ApprovalRule[] {
    return this.sessionRules.get(session) ?? []
  }

  /**
   * Append one rule to a project's stored rules.
   * @param cwd - the project directory.
   * @param rule - the rule to append.
   * @returns the project's complete rule list after the write.
   * @throws when the deployment mounts no storage domain for rules.
   */
  async addProjectRule(cwd: string, rule: ApprovalRule): Promise<readonly ApprovalRule[]> {
    assertRule(rule)
    const table = this.requireProjectRules()
    const existing = table.get(cwd)?.rules ?? []
    const rules = [...existing, rule]
    await table.put(cwd, { rules })
    return rules
  }

  /**
   * Remove one rule from a project by zero-based position.
   * @param cwd - the project directory.
   * @param index - the rule's position in {@link projectRulesFor}.
   * @returns the removed rule, or `undefined` when the position does not exist.
   * @throws when the deployment mounts no storage domain for rules.
   */
  async removeProjectRule(cwd: string, index: number): Promise<ApprovalRule | undefined> {
    const table = this.requireProjectRules()
    const existing = table.get(cwd)?.rules ?? []
    const removed = existing[index]
    if (removed === undefined) return undefined
    const rules = existing.filter((_rule, position) => position !== index)
    if (rules.length === 0) await table.delete(cwd)
    else await table.put(cwd, { rules })
    return removed
  }

  /**
   * Run `/correct <callId> <text>`: record replacement arguments for a pending
   * call. The user still rejects the request; the pipeline attaches this text
   * to the rejection the model sees.
   * @param invocation - the parsed command line and its agent.
   * @returns the command's user-facing result.
   */
  private correctCommand(invocation: CommandInvocation): CommandResult {
    const [callId, ...text] = invocation.rawInput.trim().split(/\s+/u)
    const correction = text.join(' ').trim()
    if (callId === undefined || callId.length === 0 || correction.length === 0) {
      return { kind: 'error', text: 'Usage: /correct <callId> <corrected arguments or instruction>' }
    }
    this.recordCorrection(invocation.agent, callId as ToolCallId, correction)
    return { kind: 'success', text: `Correction recorded for ${callId}. Reject the request to send it to the model.` }
  }

  /**
   * Run the `/allow` command: `list`, `remove <n>`, or `<action> <resource>
   * [effect]`, scoped to the invoking session's project directory or, with
   * `--session`, to the live session only.
   * @param invocation - the parsed command line and its agent.
   * @returns the command's user-facing result.
   */
  private async allowCommand(invocation: CommandInvocation): Promise<CommandResult> {
    const session = invocation.agent.session
    const cwd = session.header.cwd
    const parsed = parseAllowInput(invocation.rawInput)
    if (parsed.kind === 'invalid') return { kind: 'error', text: parsed.message }
    if (parsed.scope === 'project' && cwd === undefined) {
      return { kind: 'error', text: 'Approval rules need a project directory; this Session records none.' }
    }
    const scope = parsed.scope
    const list = scope === 'session' ? this.sessionRulesFor(session) : this.projectRulesFor(cwd)
    const target = scope === 'session' ? 'this Session' : String(cwd)
    if (parsed.kind === 'list') {
      return {
        kind: 'success',
        text: list.length === 0
          ? `No approval rules for ${target}.`
          : list.map((rule, index) => `${index + 1}. ${describeRule(rule)}`).join('\n'),
      }
    }
    if (parsed.kind === 'remove') {
      const removed = scope === 'session'
        ? this.removeSessionRule(session, parsed.index)
        : await this.removeProjectRule(String(cwd), parsed.index)
      return removed === undefined
        ? { kind: 'error', text: `No approval rule ${parsed.index + 1} for ${target}.` }
        : { kind: 'success', text: `Removed ${describeRule(removed)}.` }
    }
    const rules = scope === 'session'
      ? this.addSessionRule(session, parsed.rule)
      : await this.addProjectRule(String(cwd), parsed.rule)
    return {
      kind: 'success',
      text: `Approval rule ${rules.length} for ${target}: ${describeRule(parsed.rule)}.`,
    }
  }

  /**
   * Record the user's replacement arguments for one pending call. The pipeline
   * consumes the text when the answer is `rejected`, so the model receives it
   * as the tool failure reason and can retry with the corrected arguments.
   * @param agent - the agent whose session owns the call.
   * @param callId - the exact tool call the correction belongs to.
   * @param text - the user's replacement arguments or instruction.
   */
  recordCorrection(agent: Agent, callId: ToolCallId, text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) throw new TypeError('approval correction text must be non-empty')
    const session = agent.session
    let calls = this.corrections.get(session)
    if (calls === undefined) {
      calls = new Map()
      this.corrections.set(session, calls)
    }
    calls.set(callId, trimmed)
  }

  /**
   * Consume one recorded correction. Reading removes it, so a stale rejection
   * reason cannot leak into a later call.
   * @param agent - the agent whose session owns the call.
   * @param callId - the exact tool call being rejected.
   * @returns the correction text, or `undefined` when none was recorded.
   */
  takeCorrection(agent: Agent, callId: ToolCallId): string | undefined {
    const calls = this.corrections.get(agent.session)
    const correction = calls?.get(callId)
    if (correction !== undefined) calls?.delete(callId)
    return correction
  }

  private requireProjectRules(): KvTable<string, ProjectApprovalRules> {
    if (this.projectRules === undefined) {
      throw new Error('project approval rules require a mounted storage domain')
    }
    return this.projectRules
  }

  /**
   * The session's effective policy: its projected override, else the
   * configured default (the schema already defaulted an omitted policy to
   * `'ask'`; the `??` only narrows the optional-input TYPE).
   * @param session - the exact accepted session whose policy applies.
   * @returns the policy every ask for this session resolves under right now.
   */
  private effectivePolicy(session: Session): ApprovalPolicy {
    return this.overrideOf(session) ?? this.config.policy ?? 'ask'
  }

  /**
   * Read the session override without applying the configured default.
   * @param session - session whose log supplies the override.
   * @returns the last logged policy, or `undefined` without one.
   */
  overrideOf(session: Session): ApprovalPolicy | undefined {
    return this.approvalStateOf(session).policy ?? undefined
  }

  private approvalStateOf(session: Session): ApprovalState {
    return this.approvalProjectionHandle.stateOf(session)
  }

  /**
   * Dispatch the waterfall, contained and raced against the request signal.
   * @param req - the borrowed public request.
   * @param session - the request agent's session used for policy lookup.
   * @returns the normalized closed outcome.
   */
  private async decide(req: ApprovalRequest, session: Session): Promise<ApprovalOutcome> {
    const signal = req.signal
    if (signal?.aborted) return 'cancelled'
    // The 'never' policy is decided HERE, before any dispatch: a listener
    // registered with `prepend: true` after this service mounts would sit
    // ahead of any gate LISTENER, so a listener-shaped gate cannot keep the
    // documented promise that 'never' rejects deterministically regardless
    // of registration order — only the service's own request path can.
    if (this.effectivePolicy(session) === 'never') return 'rejected'
    // Enter the promise chain BEFORE dispatching: a listener that throws
    // SYNCHRONOUSLY (before its first await) must land in the same rejection
    // path as an async one — `Promise.resolve(call())` would let it escape
    // the containment into the caller.
    const answer: Promise<ApprovalOutcome> = Promise.resolve().then(
      () => this.ctx.waterfall(
        scopeTarget(req.agent, req.agent), 'approval/request', req,
        () => Promise.resolve<ApprovalOutcome>('unavailable'),
      ),
    ).then(
      // Normalize a rogue (non-vocabulary) answerer return to the fail-closed
      // outcome instead of leaking it into callers' closed-union switches.
      outcome => OUTCOMES.includes(outcome) ? outcome : 'unavailable',
      // A throwing answerer must fail the QUESTION closed, not the caller's
      // tool call open — the seam contains its callbacks.
      () => 'unavailable',
    )
    if (signal === undefined && (this.config.timeoutMs ?? 0) <= 0) return answer
    return await new Promise<ApprovalOutcome>((resolve) => {
      const timeoutMs = this.config.timeoutMs ?? 0
      const timer = timeoutMs > 0
        ? setTimeout(() => { finish('timed-out') }, timeoutMs)
        : undefined
      const finish = (outcome: ApprovalOutcome): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = () => { finish('cancelled') }
      signal?.addEventListener('abort', onAbort, { once: true })
      void answer.then((outcome) => {
        // After an abort or timeout won the race these settles are no-ops:
        // the late answer is discarded by construction.
        finish(outcome)
      })
    })
  }
}

export default ApprovalService

/** Refuse a rule whose fields cannot be evaluated. */
function assertRule(rule: ApprovalRule): void {
  if (rule.action.length === 0 || rule.resource.length === 0) {
    throw new TypeError('approval rule action and resource must be non-empty')
  }
  if (rule.match === 'prefix' && (splitCommandWords(rule.resource)?.length ?? 0) === 0) {
    throw new TypeError('approval prefix rule resource must be a shell command prefix')
  }
}

/** Render one rule for command output. */
function describeRule(rule: ApprovalRule): string {
  return `${rule.effect} ${rule.match} ${rule.action} ${rule.resource}`
}

/** One parsed `/allow` invocation. */
type ParsedAllow =
  | { readonly kind: 'list'; readonly scope: AllowScope }
  | { readonly kind: 'remove'; readonly scope: AllowScope; readonly index: number }
  | { readonly kind: 'add'; readonly scope: AllowScope; readonly rule: ApprovalRule }
  | { readonly kind: 'invalid'; readonly message: string }

/** Where added rules live: the project's storage or this Session's memory. */
type AllowScope = 'project' | 'session'

/** Usage text shared by every invalid `/allow` form. */
const ALLOW_USAGE = 'Usage: /allow [--session] [--prefix] list | remove <n> | <action> <resource> [allow|deny|ask]'

/**
 * Parse the `/allow` grammar: optional `--session` and `--prefix` flags, then
 * `list`, `remove <n>`, or `<action> <resource> [effect]`. Flags may appear in
 * either order. A prefix rule takes the remaining words as its literal prefix.
 */
function parseAllowInput(rawInput: string): ParsedAllow {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  let scope: AllowScope = 'project'
  let match: ApprovalRuleMatch = 'glob'
  while (tokens[0] === '--session' || tokens[0] === '--prefix') {
    if (tokens[0] === '--session') scope = 'session'
    else match = 'prefix'
    tokens.shift()
  }
  const [first, ...rest] = tokens
  if (first === undefined) return { kind: 'invalid', message: ALLOW_USAGE }
  if (first === 'list') return rest.length === 0 ? { kind: 'list', scope } : { kind: 'invalid', message: ALLOW_USAGE }
  if (first === 'remove') {
    const index = rest.length === 1 ? Number(rest[0]) : Number.NaN
    return Number.isSafeInteger(index) && index > 0
      ? { kind: 'remove', scope, index: index - 1 }
      : { kind: 'invalid', message: 'Usage: /allow [--session] remove <n>' }
  }
  if (first.startsWith('--')) return { kind: 'invalid', message: ALLOW_USAGE }
  const last = rest.at(-1)
  const explicit = rest.length >= 2 && (last === 'allow' || last === 'deny' || last === 'ask') ? last : undefined
  const effect = explicit ?? 'allow'
  const resource = (explicit === undefined ? rest : rest.slice(0, -1)).join(' ')
  if (resource.length === 0) return { kind: 'invalid', message: ALLOW_USAGE }
  const rule: ApprovalRule = { action: first, resource, effect, match }
  return { kind: 'add', scope, rule }
}
