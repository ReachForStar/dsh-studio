/**
 * a2a 服务状态 store：查询 a2a/status Remote，维护状态快照，供设置页
 * 指示器消费。通过 ctx.provide('a2aStatus', store) 暴露查询状态。
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { A2AStatus } from '@reachforstar/dsh-a2a-status/types'

/** a2a/status Remote 的调用面。 */
export interface A2aStatusRemoteFace {
  status(): Promise<A2AStatus>
}

/** 状态快照。 */
export interface A2aStatusState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** a2a-host 是否已运行；查询失败时为 false。 */
  available: boolean
  hostRunning: boolean
  hostPort: number
  kafkaPhase: 'starting' | 'ready' | 'unavailable'
  kafkaReady: boolean
  kafkaBrokers: readonly string[]
  kafkaReason: string
  /** 查询失败时的错误文本。 */
  error: string | null
}

const IDLE_STATE: A2aStatusState = {
  status: 'idle',
  available: false,
  hostRunning: false,
  hostPort: 0,
  kafkaPhase: 'starting',
  kafkaReady: false,
  kafkaBrokers: [],
  kafkaReason: '',
  error: null,
}

/**
 * 将 Remote 报错转为文本。
 * @param error - 未知类型的错误值。
 * @returns Error 实例的消息，其他值转为字符串。
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * a2a 服务状态控制器：查询 Remote，维护快照，供设置页状态指示器消费。
 * 通过 ctx.provide 暴露后，其他包用 ctx.get('a2aStatus') 可选拿。
 */
export class A2aStatusStore {
  /** uSES 安全的快照 store。 */
  readonly store: SnapshotStore<A2aStatusState> = createSnapshotStore<A2aStatusState>(IDLE_STATE)

  /** 最新查询胜出。 */
  private generation = 0
  /** 已销毁则拒绝再查。 */
  private disposed = false

  constructor(private readonly remote: A2aStatusRemoteFace) {}

  /** 从 Remote 刷新状态快照。 */
  async load(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      const result = await this.remote.status()
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'ready'
        state.error = null
        state.hostRunning = result.hostRunning
        state.hostPort = result.hostPort
        state.kafkaPhase = result.kafkaPhase
        state.kafkaReady = result.kafkaReady
        state.kafkaBrokers = result.kafkaBrokers
        state.kafkaReason = result.kafkaReason
        state.available = result.hostRunning
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = messageOf(error)
        state.available = false
      })
    }
  }

  /** 销毁控制器（HMR 安全）。 */
  dispose(): void {
    this.generation += 1
    this.disposed = true
  }
}
