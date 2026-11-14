# User Approval

English | [中文](approval.zh.md)

The user-approval seam of [dsh-user-approval](../../packages/interaction/user-approval) answers one question: may this specific action proceed? It owns the shared request/outcome vocabulary, the `ctx.approval` dispatch service, the `approval/request` answerer waterfall, the log-only audit pair, and the per-session `ask`/`never` policy. UI channels may provide human answerers; the [ACP automation bridge](../../packages/acp/acp) provides one-shot machine decisions for its own agents. Callers such as [dsh-tools](../../packages/core/tools) and [dsh-tool-bash](../../packages/shell/tool-bash) consume the closed outcome and fail closed unless it is `allowed-once`.

Source: [`packages/interaction/user-approval/src/index.ts`](../../packages/interaction/user-approval/src/index.ts)

## Identity and outcome

Every request receives a fresh `ApprovalRequestId`. The brand pairs the `approval/asked` and `approval/decided` audit events without making approval ids interchangeable with tool-call or agent/session ids.

```ts type-equiv
/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
type ApprovalRequestId = Branded<'ApprovalRequestId'>
```

`ApprovalOutcome` is closed and fail-closed. `allowed-once` grants only the asked-about action; callers deny on `rejected`, `cancelled`, `unavailable`, and `timed-out`. A missing, non-owning, throwing, or non-conforming answerer becomes `unavailable` rather than opening the gate; an elapsed answer window becomes `timed-out`.

```ts type-equiv
/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, unavailable answerer, or an elapsed answer window. Callers fail
 * closed on everything except `allowed-once`.
 */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'timed-out'
```

## Per-session policy

`ApprovalPolicy` determines what happens before interactive answerers run. `ask` delegates to the composed answerer chain, whose no-answer default is `unavailable`; `never` deterministically returns `rejected` without dispatching any answerer. The effective value is the last `approval/policy` event in the session log, falling back to the service config. Consumers read it with `ctx.approval.effectivePolicy(session)`; `setApprovalPolicy(session, policy)` is the single write path, so replay reconstructs the override.

```ts type-equiv
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
type ApprovalPolicy = 'ask' | 'never'
```

Both policies contribute their complete current meaning to the cache-safe runtime-context snapshot. The sourced `user/message` is the durable model-visible input; changing approval state appends a new full snapshot after retained history without touching the `system/message` nodes that hold the rendered system prompt.

## Approval request

`ApprovalRequest` identifies the agent and tool action closely enough to route and audit the question. It deliberately omits tool arguments: an answerer attaches the prompt to the already-streamed tool call through `callId` instead of rendering a second copy that could drift. Optional `displayReason` carries requester-owned locale strings to presentation; `reason` remains the audit text.

```ts type-equiv
/**
 * Readonly same-process permission question. `callId` links to an already
 * presented tool call, so arguments are not duplicated here.
 */
interface ApprovalRequest extends ApprovalRequestEvent {
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
```

## Full-access commit

An approval prompt is also the place a person can grant full access instead of deciding one action. `registerFullAccess(handler)` installs the single applier; while one is registered, every dispatched `ApprovalRequestEvent` carries `requestId` and `fullAccess: true`. `requestFullAccess(agent, requestId)` requires that exact request to still wait (`FULL_ACCESS_STALE` otherwise), refuses a second commit for the same session while the first settles (`FULL_ACCESS_BUSY`), and fails without an applier (`FULL_ACCESS_UNAVAILABLE`). It appends one `approval/full-access` receipt holding the pending input identities, then runs the applier; a retry for the same request reuses the receipt, so input queued later stays outside the grant. The receipt is a log-only audit record, not a rule: nothing about it auto-allows a later request.

## Dispatch and audit

`ctx.approval.request(req)` requires the requesting session to be inside an open turn. It appends `approval/asked`, obtains one outcome, appends the matching `approval/decided`, and resolves with that outcome. The `never` policy is enforced inside the service before waterfall dispatch, so even an answerer registered later with `prepend` cannot bypass it. Answerers return an outcome when they own the request or call `next()` to delegate; the first answer occupies the single decision slot.

The audit events are log-only and do not enter the model transcript. Model-visible behavior is the caller's derived tool result plus the current runtime-context snapshot. Service disposal removes its context contribution; answerer listeners are independently effect-bound to their owning plugins.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxapproval--approvalservice"></a>

### `ctx.approval` — `ApprovalService`

Approval service that applies session policy before answerers and logs every ask/outcome pair to the requesting session. It exposes deterministic policy changes to the model through the runtime-context snapshot and switch notices.

```ts cordis-catalog
/**
 * Switch one live agent's policy and queue the transition for its next model
 * step. Session initialization uses {@link setApprovalPolicy} directly
 * because there is no previously visible policy to change.
 * @param agent - the live agent whose policy is changing.
 * @param policy - the new effective policy.
 */
setPolicy(agent: Agent, policy: ApprovalPolicy): void

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
async request(req: ApprovalRequest): Promise<ApprovalOutcome>

/**
 * Record the one applier that grants full access from an approval prompt.
 * A deployment registers at most one: the commit is a single explicit
 * action, not a rule, and two independent appliers could widen the same
 * session twice with different meanings. While a handler is registered,
 * every dispatched request advertises `fullAccess`, so clients can offer
 * the action only where the host can execute it.
 * @param handler - invoked after the receipt commits; owns the policy write.
 * @returns the disposer that withdraws this handler.
 * @throws when another handler is already registered.
 */
registerFullAccess(handler: FullAccessHandler): () => void

/**
 * Whether one approval request is still waiting for its decision.
 * @param session - the session that owns the request.
 * @param requestId - the request identity carried to the client.
 * @returns whether an answerer chain is still awaiting this request.
 */
isPending(session: Session, requestId: ApprovalRequestId): boolean

/**
 * Commit full access for one pending prompt. This is a distinct action, not
 * an allowed-once outcome: it records a durable receipt for the exact
 * request, covers the input identities pending when it commits, and then
 * hands the receipt to the registered applier, which writes the wider
 * policy. The targets are fixed at the first commit; a retry for the same
 * request reuses them, so input queued after the commit stays outside the
 * grant. One commit per session may be in flight: a concurrent retry fails
 * with `FULL_ACCESS_BUSY` instead of racing the policy write.
 * @param agent - the agent whose pending request is being granted.
 * @param requestId - the exact pending request the user acted on.
 * @returns the committed receipt: request identity and covered targets.
 * @throws `FullAccessError` when the request is no longer pending, the
 *   composition has no applier, or another commit is still in flight.
 */
async requestFullAccess(agent: Agent, requestId: ApprovalRequestId): Promise<FullAccessCommit>

/**
 * Read the rules stored for one project directory.
 * @param cwd - the session's recorded working directory.
 * @returns the stored rules, or none without a directory or storage.
 */
projectRulesFor(cwd: string | undefined): readonly ApprovalRule[]

/**
 * Read the rules added to one Session's memory for its lifetime.
 * @param session - the session whose rules apply.
 * @returns the session's ordered rules.
 */
sessionRulesFor(session: Session): readonly ApprovalRule[]

/**
 * Append one in-memory rule to a Session. The rule is evaluated after
 * project rules and disappears with the Session; nothing is persisted.
 * @param session - the session receiving the rule.
 * @param rule - the rule to append.
 * @returns the session's complete rule list after the write.
 */
addSessionRule(session: Session, rule: ApprovalRule): readonly ApprovalRule[]

/**
 * Remove one in-memory rule from a Session by position.
 * @param session - the session owning the rule.
 * @param index - the rule's position in {@link sessionRulesFor}.
 * @returns the removed rule, or `undefined` when the position does not exist.
 */
removeSessionRule(session: Session, index: number): ApprovalRule | undefined

/**
 * Append one rule to a project's stored rules.
 * @param cwd - the project directory.
 * @param rule - the rule to append.
 * @returns the project's complete rule list after the write.
 * @throws when the deployment mounts no storage domain for rules.
 */
async addProjectRule(cwd: string, rule: ApprovalRule): Promise<readonly ApprovalRule[]>

/**
 * Remove one rule from a project by zero-based position.
 * @param cwd - the project directory.
 * @param index - the rule's position in {@link projectRulesFor}.
 * @returns the removed rule, or `undefined` when the position does not exist.
 * @throws when the deployment mounts no storage domain for rules.
 */
async removeProjectRule(cwd: string, index: number): Promise<ApprovalRule | undefined>

/**
 * Record the user's replacement arguments for one pending call. The pipeline
 * consumes the text when the answer is `rejected`, so the model receives it
 * as the tool failure reason and can retry with the corrected arguments.
 * @param agent - the agent whose session owns the call.
 * @param callId - the exact tool call the correction belongs to.
 * @param text - the user's replacement arguments or instruction.
 */
recordCorrection(agent: Agent, callId: ToolCallId, text: string): void

/**
 * Consume one recorded correction. Reading removes it, so a stale rejection
 * reason cannot leak into a later call.
 * @param agent - the agent whose session owns the call.
 * @param callId - the exact tool call being rejected.
 * @returns the correction text, or `undefined` when none was recorded.
 */
takeCorrection(agent: Agent, callId: ToolCallId): string | undefined

/**
 * Read the session override without applying the configured default.
 * @param session - session whose log supplies the override.
 * @returns the last logged policy, or `undefined` without one.
 */
overrideOf(session: Session): ApprovalPolicy | undefined
```

Types: [Agent](core.md) · [Session](session.md) · [ToolCallId](llm-streaming.md)

Source: [`packages/interaction/user-approval/src/index.ts`](../../packages/interaction/user-approval/src/index.ts)

<a id="approval-events"></a>

### `approval/*` events

<a id="approvalrequest--waterfall"></a>

#### `approval/request` — waterfall

Ask composed answerers for one decision. Return an outcome to claim the request or call `next()` to delegate. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.

```ts cordis-catalog
/**
 * Ask composed answerers for one decision. Return an outcome to claim the
 * request or call `next()` to delegate. Scope-filtered dispatch
 * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @param req - pending approval request.
 * @mode waterfall
 */
'approval/request'( this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>, ): Promise<ApprovalOutcome>
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/interaction/user-approval/src/types.ts`](../../packages/interaction/user-approval/src/types.ts)
<!-- END GENERATED cordis-surface -->
