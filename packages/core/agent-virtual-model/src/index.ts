/**
 * 虚拟模型路由：注册可选的虚拟模型，并在每次请求时解析为物理 provider/model。
 *
 * 用户选择记录虚拟模型（`model/selection` 不变），请求头记录解析后的物理模型。
 * 路由器可返回状态，状态作为 log-only 事件持久化并随会话分支折叠。
 *
 * @module @deepseek-ai/dsh-agent-virtual-model
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {
  ModelRouteRequest,
  ModelRouteResolver,
  VirtualModelDefinition,
} from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 虚拟模型路由状态。log-only：不进入模型可见表面。
     * 每条记录一个虚拟模型的当前状态。
     */
    'virtual-model/state': {
      /** 虚拟模型 provider。 */
      provider: string
      /** 虚拟模型 id。 */
      modelId: string
      /** 路由器保存的 JSON 状态。 */
      state: unknown
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    virtualModels: VirtualModelService
  }
}

/** 一个虚拟模型的路由状态。 */
export interface VirtualModelState {
  readonly provider: string
  readonly modelId: string
  readonly state: unknown
}

/** 路由状态投影：每个虚拟模型最近一次状态。 */
export const virtualModelStateProjectionDefinition: ProjectionDefinition<'virtualModelState', VirtualModelState[]> = {
  key: 'virtualModelState',
  stateVersion: 1,
  stateSchema: z.array(z.object({
    provider: z.string(),
    modelId: z.string(),
    state: z.unknown(),
  })),
  init: (): VirtualModelState[] => [],
  apply: (state: VirtualModelState[], event): VirtualModelState[] => {
    if (event.type !== 'virtual-model/state') return state
    const next = state.filter(entry => entry.provider !== event.data.provider || entry.modelId !== event.data.modelId)
    return [...next, { provider: event.data.provider, modelId: event.data.modelId, state: event.data.state }]
  },
}

/** 虚拟模型注册表的键。 */
function routeKey(provider: string, id: string): string {
  return `${provider}/${id}`
}

/**
 * 虚拟模型服务（`ctx.virtualModels`）：注册虚拟模型并解析每次请求的物理选择。
 */
export class VirtualModelService extends Service {
  /** 服务名。 */
  static provide = 'virtualModels'
  static inject = ['sessionProjections']

  constructor(ctx: Context) {
    super(ctx, 'virtualModels')
  }

  private readonly registry = new Map<string, VirtualModelDefinition>()
  private stateHandle!: ProjectionHandle<VirtualModelState[]>

  protected async [Service.init](): Promise<void> {
    this.stateHandle = await this.ctx.sessionProjections.register(virtualModelStateProjectionDefinition)
  }

  /**
   * 注册或替换一个虚拟模型。
   * @param definition - 虚拟模型定义。
   * @returns 注销该定义的函数。
   */
  register(definition: VirtualModelDefinition): () => void {
    const key = routeKey(definition.provider, definition.id)
    this.registry.set(key, definition)
    return () => {
      if (this.registry.get(key) === definition) this.registry.delete(key)
    }
  }

  /**
   * 注销一个虚拟模型。
   * @param provider - provider。
   * @param id - 模型 id。
   */
  unregister(provider: string, id: string): void {
    this.registry.delete(routeKey(provider, id))
  }

  /**
   * 列出已注册的虚拟模型定义。
   * @returns 注册顺序的定义列表。
   */
  list(): readonly VirtualModelDefinition[] {
    return [...this.registry.values()]
  }

  /**
   * 解析一次选择：未注册为虚拟模型时原样返回。
   * @param session - 会话，用于读写路由状态。
   * @param selection - 用户选择或路由 fallback。
   * @param request - 请求上下文。
   * @returns 本次请求使用的物理选择。
   */
  async resolve(session: Session, selection: ModelSelection, request: ModelRouteRequest): Promise<ModelSelection> {
    const definition = this.registry.get(routeKey(selection.provider, selection.model))
    if (definition === undefined) return selection
    const state = this.stateOf(session, definition.provider, definition.id)
    const result = await definition.route({ ...request, state })
    if (result.state !== undefined && result.state !== state) {
      session.append('virtual-model/state', { provider: definition.provider, modelId: definition.id, state: result.state })
    }
    return result.selection
  }

  /** 读取一个虚拟模型的当前状态。 */
  private stateOf(session: Session, provider: string, modelId: string): unknown {
    const entry = this.stateHandle.stateOf(session).find(item => item.provider === provider && item.modelId === modelId)
    return entry?.state
  }

  /**
   * 绑定会话的解析器，供 `AgentModel` 使用。
   * @param session - 会话。
   * @returns 解析器。
   */
  resolverFor(session: Session): ModelRouteResolver {
    return {
      resolve: (selection, request) => this.resolve(session, selection, request),
    }
  }
}

export const name = 'virtual-model'

export const inject = ['sessionProjections']

export default VirtualModelService
