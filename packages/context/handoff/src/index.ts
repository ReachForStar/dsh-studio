/**
 * `/handoff` 命令：把当前会话的模型可见历史提取成自包含的新会话提示词草稿。
 *
 * 与压缩不同，本命令不改动当前会话：它用一次辅助模型请求读取派生历史与用户
 * 给出的目标，产出一份可直接粘贴到新会话的提示词，命令结果回给操作者。辅助
 * 请求不进模型表面，只作为 `command/done` 的结果文本与 `handoff` purpose 的
 * 模型调用存在。
 *
 * @module @deepseek-ai/dsh-handoff
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm/types'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/types'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'handoff': true
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 本包为生成新会话提示词草稿发起的辅助请求。 */
    'handoff': { kind: 'handoff' }
  }
}

/** 辅助提示词请求超时的终止原因码。 */
export const HANDOFF_TIMEOUT_CODE = 'HANDOFF_TIMEOUT'

/** 辅助提示词请求的配置。 */
export interface Config {
  /** 单次请求的输出 token 上限。 */
  maxOutputTokens: number
  /** 端到端辅助请求截止时间（毫秒）。 */
  timeoutMs: number
  /** 纳入派生历史的消息条数上限。 */
  maxHistoryMessages: number
  /** 可选的显式 provider 路由；必须与 `model` 成对。 */
  provider?: string
  /** 可选的显式 model id；必须与 `provider` 成对。 */
  model?: string
}

/** 配置 schema；`provider` 与 `model` 的成对校验由 {@link resolveConfig} 负责。 */
export const Config: z<Config> = z.object({
  maxOutputTokens: z.number().step(1).min(1).default(2048),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxHistoryMessages: z.number().step(1).min(1).default(40),
  provider: z.string(),
  model: z.string(),
})

/**
 * 校验已解析的配置；`provider` 与 `model` 必须同时出现或同时缺省。
 * @param config - 已由 {@link Config} 解析并填好默认值的配置。
 * @returns 原配置。
 */
export function resolveConfig(config: Config): Config {
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('handoff: provider and model must be configured together')
  }
  return config
}

/** 辅助模型的系统指令：只产出提示词本身，不加前言。 */
export const HANDOFF_SYSTEM = [
  'You are a context transfer assistant. Given a conversation history and the user\'s goal for a new thread, write one self-contained prompt that starts the new thread.',
  'The prompt must include: the relevant context and decisions, the files that were discussed or modified, and the next task stated from the user\'s goal.',
  'Write the prompt itself, with no preamble and no explanation of what you are doing.',
].join('\n')

/** 解析并校验成对的 provider/model 配置。 */
function configuredRoute(config: Config): { provider: string; model: string } | undefined {
  if (config.provider === undefined || config.model === undefined) return undefined
  return { provider: config.provider, model: config.model }
}

/** 取本次请求使用的路由：显式配置优先，否则用会话当前选择。 */
function routeOf(config: Config, selection: Readonly<ModelSelection> | undefined): { provider: string; model: string } {
  const configured = configuredRoute(config)
  if (configured !== undefined) return configured
  if (selection === undefined) {
    throw new Error('handoff: no configured provider/model and the session has no model selection')
  }
  return { provider: selection.provider, model: selection.model }
}

/**
 * 组装辅助请求的消息：截断到最近若干条的派生历史，加上目标消息。
 * @param history - 会话派生历史。
 * @param goal - 用户给出的新会话目标。
 * @param maxHistoryMessages - 历史条数上限。
 * @returns 辅助请求的消息列表。
 */
export function buildHandoffMessages(history: readonly Message[], goal: string, maxHistoryMessages: number): Message[] {
  const recent = maxHistoryMessages >= history.length ? [...history] : history.slice(-maxHistoryMessages)
  return [
    ...recent,
    createUserMessage({
      content: [{ type: 'text', text: goal }],
      source: { kind: 'handoff' },
    }),
  ]
}

/**
 * 请求一次提示词草稿。
 * @param ctx - 宿主上下文。
 * @param invocation - 命令调用。
 * @param config - 生效配置。
 * @returns 辅助模型产出的提示词文本。
 */
export async function requestHandoffPrompt(ctx: Context, invocation: CommandInvocation, config: Config): Promise<string> {
  const route = routeOf(config, invocation.agent.model.current())
  const history = invocation.agent.session.deriveMessages()
  const messages = buildHandoffMessages(history, invocation.rawInput.trim(), config.maxHistoryMessages)
  using callDeadline = deadline(invocation.signal, config.timeoutMs, HANDOFF_TIMEOUT_CODE)
  const call = await ctx.llm.prepareCall(
    { provider: route.provider, model: route.model, maxTokens: config.maxOutputTokens },
    callDeadline.signal,
  )
  const assembler = new BlockAssembler()
  for await (const chunk of call.stream({
    ...call.config,
    messages,
    system: HANDOFF_SYSTEM,
    sessionId: invocation.agent.session.id,
    purpose: 'handoff',
    signal: callDeadline.signal,
  })) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  const text = assembler.blocks()
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
    .trim()
  if (text.length === 0) throw new Error('handoff: the assistant returned no text')
  return text
}

/**
 * 执行 `/handoff`：目标为空时给出用法。
 * @param ctx - 宿主上下文。
 * @param invocation - 命令调用。
 * @param config - 生效配置。
 * @returns 命令结果；成功时文本为提示词草稿。
 */
export async function executeHandoff(ctx: Context, invocation: CommandInvocation, config: Config): Promise<CommandResult> {
  const goal = invocation.rawInput.trim()
  if (goal.length === 0) {
    return { kind: 'error', text: 'Usage: /handoff <goal for the next session>' }
  }
  const prompt = await requestHandoffPrompt(ctx, invocation, config)
  return { kind: 'success', text: prompt }
}

export const name = 'handoff'

export const inject = ['commands', 'llm']

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.commands.register({
    definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-handoff'),
    name: 'handoff',
    description: 'Draft a self-contained prompt for a new session from this conversation',
    input: { hint: '<goal for the next session>' },
    handler: invocation => executeHandoff(ctx, invocation, resolved),
  })
}
