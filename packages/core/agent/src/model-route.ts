/**
 * 虚拟模型路由契约：一个可选的模型解析器，把用户选择的虚拟 provider/model
 * 解析为每次请求使用的物理 provider/model。
 *
 * @module @deepseek-ai/dsh-agent/model-route
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from './types.ts'

/** 一次模型请求的由来。 */
export type ModelRouteReason = 'user' | 'continuation' | 'retry' | 'direct'

/** 路由请求上下文。 */
export interface ModelRouteRequest {
  /** 请求的由来。 */
  readonly reason: ModelRouteReason
  /** 最近一次成功响应使用的物理模型。 */
  readonly previous: ModelSelection | undefined
  /** 失败请求使用的物理模型（仅 `retry`）。 */
  readonly failed: ModelSelection | undefined
  /** 该会话分支上保存的路由状态。 */
  readonly state: unknown
  /** 本次请求的消息。 */
  readonly messages: readonly Message[]
  /** 请求取消信号。 */
  readonly signal: AbortSignal
}

/** 路由结果。 */
export interface ModelRouteResult {
  /** 本次请求使用的物理选择。 */
  readonly selection: ModelSelection
  /** 需要保存的路由状态；省略表示保持原状态。 */
  readonly state?: unknown
}

/** 虚拟模型路由器。 */
export type ModelRouter = (request: ModelRouteRequest) => ModelRouteResult | Promise<ModelRouteResult>

/** 一个可选择的虚拟模型。 */
export interface VirtualModelDefinition {
  /** 虚拟模型列出的 provider。 */
  readonly provider: string
  /** 虚拟模型 id。 */
  readonly id: string
  /** 显示名。 */
  readonly name: string
  /** 可选的 thinking level 列表。 */
  readonly thinkingLevels?: readonly string[]
  /** 声明的上下文窗口，用于首次响应前的展示。 */
  readonly contextWindow?: number
  /** 声明的输出上限。 */
  readonly maxTokens?: number
  /** 每次请求的路由函数。 */
  readonly route: ModelRouter
}

/** 模型解析器：把选择解析为物理选择；无匹配时返回原选择。 */
export interface ModelRouteResolver {
  /**
   * 解析一次选择。
   * @param selection - 用户选择或路由 fallback。
   * @param request - 请求上下文。
   * @returns 本次请求使用的物理选择。
   */
  resolve(selection: ModelSelection, request: ModelRouteRequest): Promise<ModelSelection>
}
