/**
 * `/label` 命令：给会话中的一条助手消息打标签或清除标签。
 *
 * 标签是 log-only 的会话元数据：它不进入模型可见表面，只作为可检索的导航标记
 * 存在。标签绑定到会话条目的序号，条目被fork复制后仍指向同一序号。
 *
 * @module @deepseek-ai/dsh-command-label
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { SessionSeq, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 给一个会话条目打标签或清除标签。log-only：不进入模型可见表面。
     * `label` 为 null 时清除该条目的标签。
     */
    'session/label': {
      /** 目标条目的会话序号。 */
      target: SessionSeq
      /** 标签文本；null 表示清除。 */
      label: string | null
    }
  }
}

/** 标签投影状态：条目序号到标签文本。 */
export type SessionLabelsState = Readonly<Record<string, string>>

/** 标签投影：从 `session/label` 事件折叠出每个条目的当前标签。 */
export const sessionLabelsProjectionDefinition = {
  key: 'sessionLabels',
  stateVersion: 1,
  stateSchema: z.record(z.string(), z.string()),
  init: (): SessionLabelsState => ({}),
  apply: (state: SessionLabelsState, event): SessionLabelsState => {
    if (event.type !== 'session/label') return state
    const key = String(event.data.target)
    if (event.data.label === null) {
      if (!(key in state)) return state
      const { [key]: _removed, ...rest } = state
      return rest
    }
    return state[key] === event.data.label ? state : { ...state, [key]: event.data.label }
  },
} satisfies ProjectionDefinition<'sessionLabels', SessionLabelsState>

/** 校验标签文本：去空白后非空且不超过 80 字符。 */
export function normalizeLabel(raw: string): string | undefined {
  const label = raw.trim()
  if (label.length === 0 || label.length > 80) return undefined
  return label
}

/** 找到当前会话中最后一条助手消息的条目序号。 */
export function lastAssistantSeq(session: { snapshotEvents(): readonly SessionEvent[] }): SessionSeq | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'assistant/message') return event.seq
  }
  return undefined
}

/** 执行 `/label`：无参数显示用法，`clear` 清除，其余文本作为标签。 */
export function executeLabel(invocation: CommandInvocation): CommandResult {
  const input = invocation.rawInput.trim()
  if (input.length === 0) return { kind: 'error', text: 'Usage: /label <name> or /label clear' }
  const target = lastAssistantSeq(invocation.agent.session)
  if (target === undefined) return { kind: 'error', text: 'No assistant message to label yet.' }
  if (input.toLowerCase() === 'clear') {
    invocation.agent.session.append('session/label', { target, label: null })
    return { kind: 'success', text: 'Label cleared.' }
  }
  const label = normalizeLabel(input)
  if (label === undefined) return { kind: 'error', text: 'Label must be 1-80 characters.' }
  invocation.agent.session.append('session/label', { target, label })
  return { kind: 'success', text: `Labeled the last assistant message as "${label}".` }
}

export const name = 'command-label'

export const inject = ['commands', 'sessionProjections']

/** 注册标签投影与 `/label` 命令。 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.sessionProjections.register(sessionLabelsProjectionDefinition)
  ctx.commands.register({
    name: 'label',
    description: 'Label or clear a label on the last assistant message',
    input: { hint: '<name>|clear' },
    handler: invocation => executeLabel(invocation),
  })
}
