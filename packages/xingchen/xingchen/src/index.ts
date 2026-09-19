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
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-system-prompt'
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
  /** A2A peer name per specialist role; must exist on the `a2a` row's `peers`. */
  peers?: XingchenPeerNames
  /** Override a specialist role's default charter (prompt-isolation text). */
  charters?: XingchenCharters
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

/** Default peer name per specialist role, overridable in config. */
const DEFAULT_PEERS: Readonly<Record<XingchenSpecialistId, string>> = {
  tianquan: 'claude-code',
  yaoguang: 'pi',
  tianliang: 'opencode',
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
  '- 用户请求明确属于专家角色（架构权衡、疑难 bug 根因、迭代规划与分波交付）时，调用 xingchen_route 委派。task 必须自包含：专家在自己的环境工作，看不到本工作区，需要把相关文件内容、diff 与上下文写进 task。',
  '- 专家回答原样转述给用户，不改动、不摘要。',
  '- 复杂任务可拆成多阶段跨角色接力（例如先瑶光复现定位、再天权称量修复方案、最后天梁排交付波次）。',
  '- 简单请求由启明直接处理；不为委派而委派。',
].join('\n')

/**
 * `ctx.xingchen`: the star-domain routing service.
 *
 * Owns the role bindings (peer + charter), the dispatch with per-session
 * peer-conversation continuity, the `xingchen_route` tool, the `/review`
 * `/bug` `/planning` commands, the routing prompt section, and the
 * `xingchen` projection registration.
 */
export class XingchenService extends Service {
  static inject = ['a2a', 'sessionProjections', 'tools', 'systemPrompt']

  /** Peer conversation continuations, keyed by `${sessionId}:${role}`; process-local. */
  private readonly continuations = new Map<string, string>()

  /** Peer and charter resolved per specialist role. */
  private readonly bindings: Readonly<Record<XingchenSpecialistId, { readonly peer: string; readonly charter: string }>>

  /**
   * @param ctx - the owning host context.
   * @param config - peer and charter bindings per specialist role.
   */
  constructor(ctx: Context, config: XingchenConfig = {}) {
    super(ctx, 'xingchen')
    const peers = config.peers ?? {}
    const charters = config.charters ?? {}
    this.bindings = {
      tianquan: { peer: peers.tianquan ?? DEFAULT_PEERS.tianquan, charter: charters.tianquan ?? DEFAULT_CHARTERS.tianquan },
      yaoguang: { peer: peers.yaoguang ?? DEFAULT_PEERS.yaoguang, charter: charters.yaoguang ?? DEFAULT_CHARTERS.yaoguang },
      tianliang: { peer: peers.tianliang ?? DEFAULT_PEERS.tianliang, charter: charters.tianliang ?? DEFAULT_CHARTERS.tianliang },
    }

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
        + 'wave-based task breakdown). The specialist runs in its own environment and cannot see this workspace — '
        + 'include the file contents, diffs, and context it needs in `task`. Use it only when the task clearly '
        + 'belongs to a specialist role; handle general coding yourself. This call waits for the specialist to '
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
        if (agent === undefined) throw new Error(`${ROUTE_TOOL} requires a calling agent (no session to continue the peer conversation on)`)
        const role = args.role
        const task = args.task
        if (task.trim().length === 0) {
          throw new Error(`${ROUTE_TOOL} requires a non-empty self-contained task`)
        }
        const reply = await this.dispatch(role, task, String(agent.session.id), exec.signal)
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
   * Dispatch one task to a specialist role through its A2A peer, prefixing
   * the role charter and continuing the per-session peer conversation.
   * @param role - the specialist role.
   * @param task - the self-contained task text.
   * @param sessionKey - the session id owning the conversation continuity.
   * @param signal - cancellation owned by the caller.
   * @returns the peer's answer and its continuation addressing.
   */
  async dispatch(
    role: XingchenSpecialistId,
    task: string,
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<A2APeerReply> {
    const binding = this.bindings[role]
    const key = `${sessionKey}:${role}`
    const contextId = this.continuations.get(key)
    const reply = await this.ctx.a2a.send({
      peer: binding.peer,
      text: `${binding.charter}\n\n---\n\n${task}`,
      ...(contextId === undefined ? {} : { contextId }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (reply.contextId !== undefined) this.continuations.set(key, reply.contextId)
    return reply
  }

  /** Address one specialist through a slash command: no model turn. */
  private async dispatchCommand(role: XingchenSpecialistId, invocation: CommandInvocation): Promise<CommandResult> {
    const task = invocation.rawInput.trim()
    if (task === '') {
      return { kind: 'error', text: `用法：/${XINGCHEN_COMMAND_ROLES[role]} <任务描述>（${XINGCHEN_ROLE_SUMMARIES[role]}）` }
    }
    let reply: A2APeerReply
    try {
      reply = await this.dispatch(role, task, String(invocation.agent.session.id), invocation.signal)
    } catch (error: unknown) {
      // A peer that cannot answer is the command's outcome, not a crashed
      // handler: report the peer's own message so the missing endpoint is
      // actionable.
      return {
        kind: 'error',
        text: `${XINGCHEN_ROLE_NAMES[role]} 委派失败：${error instanceof Error ? error.message : String(error)}`,
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
