/**
 * 输入拦截：让扩展在用户输入进入模型之前拦截、改写或就地处理。
 *
 * 拦截器按注册顺序被调用；返回 `handled` 表示扩展已就地处理，输入不进入
 * 模型也不追加会话消息；返回 `transform` 用新文本替换输入；返回 `continue`
 * 交给下一个拦截器。全部返回 `continue` 时输入原样提交。
 *
 * @module @deepseek-ai/dsh-input-handled
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    inputHandling: InputHandlingService
  }
}

/** 拦截结果。 */
export type InputDecision =
  | { readonly action: 'continue' }
  | { readonly action: 'transform'; readonly text: string }
  | { readonly action: 'handled' }

/** 一个输入拦截器。 */
export interface InputInterceptor {
  /**
   * 处理一条用户输入。
   * @param agent - 接收输入的代理。
   * @param text - 输入文本。
   * @param signal - 取消信号。
   * @returns 拦截结果。
   */
  intercept(agent: Agent, text: string, signal: AbortSignal): InputDecision | Promise<InputDecision>
}

/**
 * 输入拦截服务（`ctx.inputHandling`）：按注册顺序调用拦截器。
 */
export class InputHandlingService extends Service {
  /** 服务名。 */
  static provide = 'inputHandling'

  private readonly interceptors: InputInterceptor[] = []

  constructor(ctx: Context) {
    super(ctx, 'inputHandling')
  }

  /**
   * 注册一个拦截器。
   * @param interceptor - 拦截器。
   * @returns 注销函数。
   */
  register(interceptor: InputInterceptor): () => void {
    this.interceptors.push(interceptor)
    return () => {
      const index = this.interceptors.indexOf(interceptor)
      if (index >= 0) this.interceptors.splice(index, 1)
    }
  }

  /**
   * 依次调用拦截器，返回第一个非 `continue` 的决策。
   * @param agent - 接收输入的代理。
   * @param text - 输入文本。
   * @param signal - 取消信号。
   * @returns 生效的决策；无拦截器命中时为 `continue`。
   */
  async handle(agent: Agent, text: string, signal: AbortSignal): Promise<InputDecision> {
    for (const interceptor of this.interceptors) {
      const decision = await interceptor.intercept(agent, text, signal)
      if (decision.action !== 'continue') return decision
    }
    return { action: 'continue' }
  }
}

export const name = 'input-handled'

export const inject = []

export default InputHandlingService
