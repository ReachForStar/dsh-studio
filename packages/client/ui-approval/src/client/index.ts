/** Browser approval consumer over the existing scoped Remote Event waterfall. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { ApprovalCard } from './ApprovalCard.tsx'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import { PendingApproval } from './contract/slots.ts'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'

export type {
  ApprovalCardInput,
  ApprovalComposerProps,
  ApprovalDecision,
  ApprovalDetailOwnerProps,
  ApprovalPresentationRequest,
  PendingApproval,
} from './contract/slots.ts'
export type { ApprovalKey } from './locales.ts'

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

const NS = 'approval'

type ApprovalListener = TypertClientEventListener<'approval/request'>
type ClientApprovalRequest = Parameters<ApprovalListener>[0]
type ClientApprovalNext = Parameters<ApprovalListener>[1]
type ClientApprovalOutcome = Awaited<ReturnType<ApprovalListener>>

/* jscpd:ignore-start -- Approval and Question intentionally mirror one Remote waterfall lifecycle. */
/** Present one request until the user answers or its lifetime ends. */
async function answerApproval(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientApprovalRequest,
  next: ClientApprovalNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingApproval>,
): Promise<ClientApprovalOutcome> {
  const sessionId = ctx.sessions.scopeOf(owner)
  if (sessionId === undefined) return next()
  const pending = new PendingApproval(sessionId, {
    toolName: request.toolName,
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    ...(request.fullAccess === true ? { fullAccess: true } : {}),
    ...(request.callId === undefined
      ? {}
      : { callId: request.callId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }),
    ...(request.action === undefined ? {} : { action: request.action }),
    ...(request.resources === undefined ? {} : { resources: request.resources }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  const completed = Promise.withResolvers<void>()
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate()
    await completed.promise
  })
  try {
    try {
      return await pending.result
    } catch (error) {
      if (pending.isDelegation(error)) return await next()
      throw error
    }
  } finally {
    remove()
    completed.resolve()
  }
}
/* jscpd:ignore-end */

/**
 * Install approval copy and the scoped waterfall consumer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-approval: dictionaries')
  ctx.inject(['shortcuts'], (scope) => {
    const t = ctx.locale.bind(NS)
    scope.effect(() => scope.shortcuts.registerFixed({
      id: 'approval.allow' as ShortcutCommandId, label: () => t('allow'), keys: ['Enter'], bindings: [{ code: 'Enter', modifiers: [] }], group: 'approval',
    }), 'ui-approval: fixed allow reference')
    scope.effect(() => scope.shortcuts.registerFixed({
      id: 'approval.reject' as ShortcutCommandId, label: () => t('reject'), keys: ['Esc'], bindings: [{ code: 'Escape', modifiers: [] }], group: 'approval',
    }), 'ui-approval: fixed reject reference')
  })
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingApproval>(
    () => 0,
  )
  ctx.slots.registerFactory({
    name: 'conversation.approval.card', scope: 'session', locale: NS,
    children: { 'conversation.approval.detail': { kind: 'single', scope: 'session' } },
  }, ApprovalCard)
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 1,
    select: ({ pendingInteraction }: ComposerChainProps): PendingApproval | null =>
      pendingInteraction instanceof PendingApproval ? pendingInteraction : null,
    locale: NS,
    inject: () => ({
      resolveReason: (reason: NonNullable<PendingApproval['displayReason']>) => ctx.locale.resolveText(reason),
      alwaysAllow: (approval: PendingApproval) => saveAlwaysAllow(ctx, approval),
      grantFullAccess: (approval: PendingApproval) => grantFullAccess(ctx, approval),
      rejectWithCorrection: (approval: PendingApproval, text: string) => rejectWithCorrection(ctx, approval, text),
    }),
  }, ApprovalPanel))
  ctx.remote.$on('approval/request', function (request, next) {
    return answerApproval(ctx, this, request, next, registerPendingInteraction)
  })
}

/**
 * Persist the pending request's scope as project allow rules through the
 * `/allow` command, then grant this request. A failed save still grants the
 * current request; the failure is logged instead of silently pretending the
 * rule exists.
 * @param ctx - client root context carrying the Remote command channel.
 * @param approval - the pending request whose action and resources become rules.
 */
async function saveAlwaysAllow(ctx: ClientContext, approval: PendingApproval): Promise<void> {
  if (approval.action === undefined) {
    await approval.answer('allowed-once')
    return
  }
  const resources = approval.resources.length === 0 ? ['*'] : approval.resources
  try {
    for (const resource of resources) {
      const result = await ctx.remote.commands.execute(
        approval.sessionId,
        `/allow ${approval.action} ${resource}`,
        [],
        new AbortController().signal,
      )
      if (!result.ok) throw new Error(`approval rule save failed: ${result.error.code}: ${result.error.message}`)
    }
  } catch (error: unknown) {
    ctx.logger.warn(`approval: ${error instanceof Error ? error.message : String(error)}`)
  }
  await approval.answer('allowed-once')
}

/**
 * Commit full access for the pending request through `/full-access`, then
 * grant the request. The Host binds the grant to the request identity, applies
 * its configured preset, and records a receipt; a failed command keeps the
 * prompt open so the user can choose another outcome.
 * @param ctx - client root context carrying the Remote command channel.
 * @param approval - the pending request whose identity the grant cites.
 */
async function grantFullAccess(ctx: ClientContext, approval: PendingApproval): Promise<void> {
  const requestId = approval.requestId
  if (requestId === undefined) throw new Error('approval: full access requires a request identity')
  const result = await ctx.remote.commands.execute(
    approval.sessionId,
    `/full-access ${requestId}`,
    [],
    new AbortController().signal,
  )
  if (!result.ok) throw new Error(`full access failed: ${result.error.code}: ${result.error.message}`)
  if (result.value === undefined) throw new Error('the host offers no /full-access command')
  if (result.value.result.kind !== 'success') throw new Error(result.value.result.text)
  await approval.answer('allowed-once')
}

/**
 * Record replacement arguments for the pending call through `/correct`, then
 * reject it. A failed save still rejects, so the user's refusal always stands.
 * @param ctx - client root context carrying the Remote command channel.
 * @param approval - the pending request being rejected.
 * @param text - the user's replacement arguments or instruction.
 */
async function rejectWithCorrection(ctx: ClientContext, approval: PendingApproval, text: string): Promise<void> {
  if (approval.callId !== undefined) {
    try {
      const result = await ctx.remote.commands.execute(
        approval.sessionId,
        `/correct ${String(approval.callId)} ${text.trim()}`,
        [],
        new AbortController().signal,
      )
      if (!result.ok) throw new Error(`approval correction failed: ${result.error.code}: ${result.error.message}`)
    } catch (error: unknown) {
      ctx.logger.warn(`approval: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await approval.answer('rejected')
}
