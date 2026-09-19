/**
 * Xingchen (星辰) star-domain routing: four roles over the A2A peer seam.
 *
 * Qiming is the native router — this harness's own coding agent, whose preset
 * persona carries the routing discipline. The three specialists (天权, 瑶光,
 * 天梁) are external agents (Pi, Claude Code, OpenCode deployments) reached
 * through A2A peers; each dispatch is prefixed with the role's charter so the
 * peer works under that role's prompt regardless of which backend occupies
 * the seat.
 *
 * Two dispatch paths, both logged: the `xingchen_route` tool (the router
 * agent delegates when intent is specialist) and the `/review`, `/bug`,
 * `/planning` commands (a human addresses a specialist directly, no model
 * turn). The `xingchen` session projection folds both plus `turn/end` into
 * the session list's role label and stop-reason.
 *
 * @module @reachforstar/dsh-xingchen
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { A2APeerReply } from '@reachforstar/dsh-a2a'
import { XINGCHEN_COMMAND_ROLES, XINGCHEN_ROLE_NAMES, XINGCHEN_ROLE_SUMMARIES, roleOfCommand, type XingchenCommandName } from './route.ts'
import { TIANLIANG_CHARTER, TIANQUAN_CHARTER, YAOGUANG_CHARTER } from './charters.ts'
import type {
  XingchenProjection, XingchenRoleId, XingchenSpecialistId, XingchenTurnReason, XingchenUnitState,
} from './types.ts'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
export type * from './types.ts'
export {
  XINGCHEN_COMMAND_ROLES, XINGCHEN_ROLE_COMMANDS, XINGCHEN_ROLE_NAMES, XINGCHEN_ROLE_SUMMARIES, routeXingchen,
} from './route.ts'
export { TIANLIANG_CHARTER, TIANQUAN_CHARTER, YAOGUANG_CHARTER } from './charters.ts'

export const name = 'xingchen'

declare module '@deepseek-ai/cordis' {
  interface Context {
    xingchen: XingchenService
  }
}

/** The tool the router agent calls to delegate a task to a specialist. */
export const ROUTE_TOOL = 'xingchen_route'

/** Deployment config: which A2A peer each specialist seat addresses. */
export interface XingchenConfig {
  /** A2A peer name per specialist role; used by seats running in `a2a` mode. */
  peers?: XingchenPeerNames
  /** Override a specialist role's default charter (prompt-isolation text). */
  charters?: XingchenCharters
  /** How each specialist seat runs; every seat defaults to a local spawned agent. */
  seats?: XingchenSeats
}

/** A2A peer name per specialist role. */
export interface XingchenPeerNames {
  /** Peer serving 天权（架构评估与代码审查） */
  readonly tianquan?: string
  /** Peer serving 瑶光（疑难 Bug 复现与根因） */
  readonly yaoguang?: string
  /** Peer serving 天梁（版本规划与分波交付） */
  readonly tianliang?: string
}

/** Charter override per specialist role. */
export interface XingchenCharters {
  /** 替换天权默认章程的文本 */
  readonly tianquan?: string
  /** 替换瑶光默认章程的文本 */
  readonly yaoguang?: string
  /** 替换天梁默认章程的文本 */
  readonly tianliang?: string
}

/** One specialist seat's runtime choice. */
export interface XingchenSeatConfig {
  /**
   * `local` runs the seat in this process as a delegated child agent (needs
   * no peer endpoint); `a2a` sends it to the configured peer. Omitted: the
   * seat is `a2a` when its peer name is configured on the `a2a` row, else
   * `local`.
   */
  readonly mode?: 'local' | 'a2a'
  /** `ctx.subagents` provider used in `local` mode; default `spawn`. */
  readonly provider?: string
  /** Child model route for `local` mode, as `provider/model`; default inherits the parent. */
  readonly model?: string
  /**
   * Skill an `a2a` seat works under, from the peer's advertised set. Defaults
   * per role: review for 天权, analysis for 瑶光 and 天梁.
   */
  readonly skill?: string
  /**
   * Channel an `a2a` seat dispatches on: `direct` waits for the answer, `bus`
   * publishes the task and returns once the peer claims it. Defaults to
   * `direct`.
   */
  readonly channel?: 'direct' | 'bus'
  /**
   * How long a `local` seat may run before its dispatch gives up, in
   * milliseconds; default 300000. On expiry the child run is disposed and the
   * dispatch fails with the elapsed limit instead of waiting forever.
   */
  readonly timeoutMs?: number
}

/** Specialist seat configuration by role. */
export interface XingchenSeats {
  /** 天权席位运行方式 */
  readonly tianquan?: XingchenSeatConfig
  /** 瑶光席位运行方式 */
  readonly yaoguang?: XingchenSeatConfig
  /** 天梁席位运行方式 */
  readonly tianliang?: XingchenSeatConfig
}

/** Default peer name per specialist role, overridable in config. */
const DEFAULT_PEERS: Readonly<Record<XingchenSpecialistId, string>> = {
  tianquan: 'claude-code',
  yaoguang: 'pi',
  tianliang: 'opencode',
}

/** Default `ctx.subagents` provider for a seat running locally. */
const DEFAULT_SEAT_PROVIDER = 'spawn'

/** Default wait before a seat's dispatch gives up, in milliseconds. */
const DEFAULT_SEAT_TIMEOUT_MS = 300_000

/** Default skill per specialist role, matching what each role's backend advertises. */
const DEFAULT_SKILLS: Readonly<Record<XingchenSpecialistId, string>> = {
  tianquan: 'code-review',
  yaoguang: 'analysis',
  tianliang: 'analysis',
}

/** Default charter per specialist role, overridable in config. */
const DEFAULT_CHARTERS: Readonly<Record<XingchenSpecialistId, string>> = {
  tianquan: TIANQUAN_CHARTER,
  yaoguang: YAOGUANG_CHARTER,
  tianliang: TIANLIANG_CHARTER,
}

/** Runtime schema for {@link XingchenConfig}. */
export const Config: z<XingchenConfig> = z.object({
  peers: z.object({
    tianquan: z.string(),
    yaoguang: z.string(),
    tianliang: z.string(),
  }),
  charters: z.object({
    tianquan: z.string(),
    yaoguang: z.string(),
    tianliang: z.string(),
  }),
  seats: z.object({
    tianquan: z.object({ mode: z.union(['local', 'a2a']), provider: z.string(), model: z.string(), skill: z.string(), channel: z.union(['direct', 'bus']), timeoutMs: z.number().min(1) }),
    yaoguang: z.object({ mode: z.union(['local', 'a2a']), provider: z.string(), model: z.string(), skill: z.string(), channel: z.union(['direct', 'bus']), timeoutMs: z.number().min(1) }),
    tianliang: z.object({ mode: z.union(['local', 'a2a']), provider: z.string(), model: z.string(), skill: z.string(), channel: z.union(['direct', 'bus']), timeoutMs: z.number().min(1) }),
  }),
})

/** Whether a string names a specialist role. */
function isSpecialistRole(role: string): role is XingchenSpecialistId {
  return role === 'tianquan' || role === 'yaoguang' || role === 'tianliang'
}

/**
 * Map one logged turn end to the projection's stop-reason view.
 * @param reason - the `turn/end` reason recorded in the session log.
 * @returns the cropped stop-reason the session list displays.
 */
export function turnReasonOf(reason: TurnEndReason): XingchenTurnReason {
  switch (reason.kind) {
    case 'completed': return { kind: 'completed' }
    case 'aborted': return { kind: 'aborted', cause: reason.reason.kind }
    case 'blocked': return { kind: 'blocked' }
    case 'error': return { kind: 'error' }
    case 'max-tokens': return { kind: 'max-tokens' }
    case 'interrupted': return { kind: 'interrupted' }
    // Merge-extensible: a kind this view does not model is an unmodeled
    // terminal state, surfaced as the generic failure label.
    default: return { kind: 'error' }
  }
}

const xingchenTurnReasonSchema: ZodType<XingchenTurnReason> = zod.union([
  zod.object({ kind: zod.literal('completed') }).strict(),
  zod.object({ kind: zod.literal('aborted'), cause: zod.enum(['user', 'parent', 'hook', 'disposed', 'legacy']) }).strict(),
  zod.object({ kind: zod.literal('blocked') }).strict(),
  zod.object({ kind: zod.literal('error') }).strict(),
  zod.object({ kind: zod.literal('max-tokens') }).strict(),
  zod.object({ kind: zod.literal('interrupted') }).strict(),
])

const xingchenStateSchema: ZodType<XingchenUnitState> = zod.object({
  lastRole: zod.union([zod.literal('qiming'), zod.literal('tianquan'), zod.literal('yaoguang'), zod.literal('tianliang')]).nullable(),
  dispatchCount: zod.number(),
  lastTurnReason: xingchenTurnReasonSchema.nullable(),
}).strict()

/**
 * Session projection: the latest dispatched role, the dispatch count, and
 * how the latest turn ended. The wire value equals the fold state, so the
 * view is the identity.
 */
export const xingchenProjectionDefinition = {
  key: 'xingchen',
  stateVersion: 1,
  stateSchema: xingchenStateSchema,
  init: () => ({ lastRole: null, dispatchCount: 0, lastTurnReason: null }),
  apply: (state, event) => {
    if (event.type === 'command/run') {
      const role = roleOfCommand(event.data.name)
      if (role === undefined) return state
      return { ...state, lastRole: role, dispatchCount: state.dispatchCount + 1 }
    }
    if (event.type === 'tool/call' && event.data.name === ROUTE_TOOL) {
      try {
        const args = JSON.parse(event.data.arguments) as { readonly role?: unknown }
        if (typeof args.role === 'string' && isSpecialistRole(args.role)) {
          return { ...state, lastRole: args.role, dispatchCount: state.dispatchCount + 1 }
        }
      } catch {
        // Malformed arguments: the event is still valid, it simply is not a
        // recognized route, so the state is untouched.
      }
      return state
    }
    if (event.type === 'turn/end') {
      return { ...state, lastTurnReason: turnReasonOf(event.data.reason) }
    }
    return state
  },
  wire: {
    viewSchema: zod.object({
      lastRole: zod.union([zod.literal('qiming'), zod.literal('tianquan'), zod.literal('yaoguang'), zod.literal('tianliang')]).nullable(),
      dispatchCount: zod.number(),
      lastTurnReason: xingchenTurnReasonSchema.nullable(),
    }).strict(),
    view: (state): XingchenProjection => state,
  },
} satisfies ProjectionDefinition<'xingchen', XingchenUnitState>

/** The routing-discipline prompt section the router agent sees. */
const ROUTING_SECTION = [
  '## 星域协作',
  '本会话有四个星域角色：启明（本代理，通用全栈开发）、天权（架构评估与代码审查）、瑶光（疑难 Bug 复现与根因）、天梁（版本规划与分波交付）。',
  '- 用户请求明确属于专家角色（架构权衡、疑难 bug 根因、迭代规划与分波交付）时，调用 xingchen_route 委派。task 必须自包含：远端专家在自己的环境工作，看不到本工作区，需要把相关文件内容、diff 与上下文写进 task。',
  '- 专家回答原样转述给用户，不改动、不摘要。',
  '- 复杂任务可拆成多阶段跨角色接力（例如先瑶光复现定位、再天权称量修复方案、最后天梁排交付波次）。',
  '- 简单请求由启明直接处理；不为委派而委派。',
].join('\n')

/** Task states that mean the seat did not answer. */
const UNFINISHED_STATES = new Set([
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
])

/**
 * `ctx.xingchen`: the star-domain routing service.
 *
 * Owns the role bindings (peer + charter), the dispatch with per-session
 * peer-conversation continuity, the `xingchen_route` tool, the `/review`
 * `/bug` `/planning` commands, the routing prompt section, and the
 * `xingchen` projection registration.
 */
export class XingchenService extends Service {
  static inject = ['a2a', 'sessionProjections', 'subagents', 'tools', 'systemPrompt']

  /** Peer conversation continuations, keyed by `${sessionId}:${role}`; process-local. */
  private readonly continuations = new Map<string, string>()

  /** Seat runtime choice and charter resolved per specialist role. */
  private readonly seats: Readonly<Record<XingchenSpecialistId, {
    readonly mode: 'local' | 'a2a'
    readonly peer: string
    readonly provider: string
    readonly model: AgentOptions | undefined
    readonly skill: string
    readonly channel: 'direct' | 'bus'
    readonly timeoutMs: number
    readonly charter: string
  }>>

  /**
   * @param ctx - the owning host context.
   * @param config - seat, peer, and charter bindings per specialist role.
   */
  constructor(ctx: Context, config: XingchenConfig = {}) {
    super(ctx, 'xingchen')
    const peers = config.peers ?? {}
    const charters = config.charters ?? {}
    const seats = config.seats ?? {}
    // A peer this deployment actually configured is the deployment saying
    // where the seat lives, so the seat defaults to it; an unconfigured role
    // stays local and needs no endpoint at all.
    const configured = new Set(ctx.a2a.list())
    /** One seat's resolved runtime choice. */
    const seat = (role: XingchenSpecialistId) => {
      const configuredSeat = seats[role] ?? {}
      const model = configuredSeat.model
      const slash = model?.indexOf('/') ?? -1
      if (model !== undefined && slash <= 0) {
        throw new Error(`xingchen: seats.${role}.model must be "provider/model", got ${JSON.stringify(model)}`)
      }
      const peer = peers[role] ?? DEFAULT_PEERS[role]
      const skill = configuredSeat.skill ?? DEFAULT_SKILLS[role]
      return {
        mode: configuredSeat.mode ?? (configured.has(peer) ? 'a2a' : 'local'),
        peer,
        provider: configuredSeat.provider ?? DEFAULT_SEAT_PROVIDER,
        model: model === undefined ? undefined : { provider: model.slice(0, slash), model: model.slice(slash + 1) },
        skill,
        channel: configuredSeat.channel ?? 'direct',
        timeoutMs: configuredSeat.timeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS,
        charter: charters[role] ?? DEFAULT_CHARTERS[role],
      }
    }
    this.seats = { tianquan: seat('tianquan'), yaoguang: seat('yaoguang'), tianliang: seat('tianliang') }

    ctx.sessionProjections.register(xingchenProjectionDefinition)

    ctx.systemPrompt.section({
      name: 'xingchen:routing',
      order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
      text: () => ROUTING_SECTION,
    })

    ctx.tools.register(defineTool({
      name: ROUTE_TOOL,
      description:
        'Delegate a self-contained task to a Xingchen specialist role: tianquan (architecture evaluation and code '
        + 'review), yaoguang (bug reproduction and root-cause attribution), tianliang (delivery planning and '
        + 'wave-based task breakdown). The specialist runs as its own agent session; a remote seat cannot see this '
        + 'workspace, so include the file contents, diffs, and context it needs in `task`. Use it only when the task '
        + 'clearly belongs to a specialist role; handle general coding yourself. This call waits for the specialist to '
        + 'finish, which can take minutes — delegate one complete unit of work, not many small round trips.',
      parameters: {
        role: {
          type: 'string',
          required: true,
          enum: ['tianquan', 'yaoguang', 'tianliang'],
          description: 'The specialist role to delegate to.',
        },
        task: {
          type: 'string',
          required: true,
          description: 'The self-contained task the specialist must complete.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', required: true, description: 'The specialist role that answered.' },
            text: { type: 'string', required: true, description: 'The specialist answer text.' },
            state: { type: 'string', description: 'Task state the specialist ended in.' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.role in XINGCHEN_ROLE_NAMES
            ? `[${XINGCHEN_ROLE_NAMES[value.role as XingchenRoleId]}] ${value.text}`
            : value.text,
        }],
      },
      presentCall: args => ({
        card: 'generic',
        title: `星域 · ${XINGCHEN_ROLE_NAMES[args.role]}`,
        kind: 'other',
        rawInput: args.task,
      }),
      execute: async (args, exec) => {
        const agent: Agent | undefined = exec.agent
        if (agent === undefined) throw new Error(`${ROUTE_TOOL} requires a calling agent (no session to delegate from)`)
        const role = args.role
        const task = args.task
        if (task.trim().length === 0) {
          throw new Error(`${ROUTE_TOOL} requires a non-empty self-contained task`)
        }
        const reply = await this.dispatch(role, task, agent, exec.signal)
        return {
          role,
          text: reply.text,
          ...reply.state === undefined ? {} : { state: reply.state },
        }
      },
    }))

    // The command child activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      for (const [role, command] of Object.entries(XINGCHEN_COMMAND_ROLES) as [XingchenSpecialistId, XingchenCommandName][]) {
        commandCtx.commands.register({
          definitionId: brandString<CommandDefinitionId>(`@reachforstar/dsh-xingchen/${command}`),
          name: command,
          description: `星域委派 · ${XINGCHEN_ROLE_NAMES[role]}（${XINGCHEN_ROLE_SUMMARIES[role]}）`,
          input: { hint: '任务描述' },
          handler: invocation => this.dispatchCommand(role, invocation),
        })
      }
    })
  }

  /**
   * Dispatch one task to a specialist seat, prefixing the role charter.
   *
   * A `local` seat runs in this process as a delegated child agent and needs no
   * endpoint; an `a2a` seat sends the same text to its configured peer and
   * continues that peer conversation per session.
   * @param role - the specialist role.
   * @param task - the self-contained task text.
   * @param parent - the agent delegating the task.
   * @param signal - cancellation owned by the caller.
   * @returns the seat's answer text and the state it ended in, when reported.
   */
  async dispatch(
    role: XingchenSpecialistId,
    task: string,
    parent: Agent,
    signal?: AbortSignal,
  ): Promise<{ readonly text: string; readonly state?: string }> {
    const seat = this.seats[role]
    const text = `${seat.charter}\n\n---\n\n${task}`
    if (seat.mode === 'a2a') {
      return await this.dispatchToPeer(role, seat.peer, seat.skill, seat.channel, text, parent, signal)
    }
    const run = await this.ctx.subagents.start(seat.provider, {
      prompt: [{ type: 'text', text }],
      parent,
      signal: signal ?? new AbortController().signal,
      ...(seat.model === undefined ? {} : { agentOptions: seat.model }),
    })
    // A local seat can stall — a composition whose child never drives a turn,
    // for instance — and a dispatch that waits forever leaves the command with
    // no result at all. Bound the wait, release the child, and fail visibly.
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => { resolve('timeout') }, seat.timeoutMs)
    })
    const settled = await Promise.race([settleRun(run).then(outcome => ({ outcome })), expiry])
    if (timer !== undefined) clearTimeout(timer)
    if (settled === 'timeout') {
      await run.dispose().catch(() => undefined)
      throw new Error(`${XINGCHEN_ROLE_NAMES[role]} 席位超过 ${String(seat.timeoutMs)}ms 未完成，已释放子运行`)
    }
    const outcome = settled.outcome
    if (outcome.status === 'completed') return { text: outcome.output ?? '', state: outcome.status }
    return { text: outcome.detail ?? `${XINGCHEN_ROLE_NAMES[role]} 席位未完成（${outcome.status}）`, state: outcome.status }
  }

  /**
   * Send one task to a peer seat and remember its conversation continuation.
   *
   * The task carries the seat's skill as message metadata, which is how a
   * bridge gateway selects the instructions and tools the peer runs with.
   */
  private async dispatchToPeer(
    role: XingchenSpecialistId,
    peer: string,
    skill: string,
    channel: 'direct' | 'bus',
    text: string,
    parent: Agent,
    signal?: AbortSignal,
  ): Promise<{ readonly text: string; readonly state?: string }> {
    const key = `${String(parent.session.id)}:${role}`
    const contextId = this.continuations.get(key)
    const bridge = this.ctx.a2a.bridgeConfig
    if (bridge !== undefined && peer in bridge.agents) {
      const reply = await this.ctx.a2a.dispatch({
        agent: peer,
        skill,
        text,
        mode: channel,
        // A seat answers the caller, so a bus dispatch must wait for the
        // terminal event; without the wait the seat would report nothing.
        ...(channel === 'bus' ? { wait: true } : {}),
        ...(contextId === undefined ? {} : { contextId }),
        ...(signal === undefined ? {} : { signal }),
      })
      if (reply.contextId !== undefined) this.continuations.set(key, reply.contextId)
      return { text: reply.text, ...reply.state === undefined ? {} : { state: reply.state } }
    }
    const reply: A2APeerReply = await this.ctx.a2a.send({
      peer,
      text,
      metadata: { skill },
      ...(contextId === undefined ? {} : { contextId }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (reply.contextId !== undefined) this.continuations.set(key, reply.contextId)
    return { text: reply.text, ...reply.state === undefined ? {} : { state: reply.state } }
  }

  /** Address one specialist through a slash command: no model turn. */
  private async dispatchCommand(role: XingchenSpecialistId, invocation: CommandInvocation): Promise<CommandResult> {
    const task = invocation.rawInput.trim()
    if (task === '') {
      return { kind: 'error', text: `用法：/${XINGCHEN_COMMAND_ROLES[role]} <任务描述>（${XINGCHEN_ROLE_SUMMARIES[role]}）` }
    }
    let reply: { readonly text: string; readonly state?: string }
    try {
      reply = await this.dispatch(role, task, invocation.agent, invocation.signal)
    } catch (error: unknown) {
      // A seat that cannot answer is the command's outcome, not a crashed
      // handler: report the seat's own message so the missing endpoint or
      // provider is actionable.
      return {
        kind: 'error',
        text: `${XINGCHEN_ROLE_NAMES[role]} 委派失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    // A seat that ran but did not finish is not an answer: a failure state
    // must not read as a result to whoever asked for the delegation.
    if (reply.state !== undefined && UNFINISHED_STATES.has(reply.state)) {
      return {
        kind: 'error',
        text: `${XINGCHEN_ROLE_NAMES[role]} 未完成（${reply.state}）：\n\n${reply.text}`,
      }
    }
    return { kind: 'success', text: `${XINGCHEN_ROLE_NAMES[role]} 已处理：\n\n${reply.text}` }
  }
}

/**
 * Register the star-domain routing service.
 * @param ctx - the owning host context.
 * @param config - peer and charter bindings per specialist role.
 */
export function apply(ctx: Context, config: XingchenConfig): void {
  ctx.plugin(XingchenService, config)
}
