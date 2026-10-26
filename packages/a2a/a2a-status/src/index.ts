/**
 * Host Remote 网关：查询 a2a-host 监听状态和 Kafka 可达性，供前端状态指示器消费。
 * a2a-host 是可选服务，未加载时报告 hostRunning: false。
 * @module @reachforstar/dsh-a2a-status
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ensureKafka, isKafkaRunning } from '@reachforstar/dsh-a2a-host/kafka-detect'
import type { KafkaEnsureResult } from '@reachforstar/dsh-a2a-host/kafka-detect'
import type { A2AStatus, KafkaFailure } from './types.ts'

export type * from './types.ts'

// 引入 a2a-host 的 Context.a2aHost 类型增强，使 ctx.get('a2aHost') 返回精确类型。
import type {} from '@reachforstar/dsh-a2a-host'

/** 默认探测的 Kafka broker 地址。 */
const DEFAULT_BROKERS: readonly string[] = ['127.0.0.1:9092', '127.0.0.1:9093', '127.0.0.1:9094']

/**
 * 从启动探测结果取出失败类别与原始诊断。
 * 这里只给结构化词汇与原始文本：展示文案由客户端 locale 字典拥有。
 * @param result - 启动探测结果；后台任务未完成时为 undefined。
 * @returns 失败类别与诊断文本；就绪或探测中时分别为 null 与空字符串。
 */
function failureOf(result?: KafkaEnsureResult): { failure: KafkaFailure; diagnostic: string } {
  return {
    failure: result === undefined ? 'no-runtime' : (result.failure ?? 'no-runtime'),
    diagnostic: result?.detail ?? '',
  }
}

/** a2a 服务状态查询的 Host Remote 网关，wire namespace 为 `a2a`。 */
export class A2AStatusGateway extends TypertRemoteService {
  /** Kafka 启动探测的当前结果；未完成时 undefined。 */
  private kafkaState: KafkaEnsureResult | undefined

  constructor(ctx: Context) {
    super(ctx, 'a2aStatusGateway', { namespace: 'a2a' })
    // 启动时后台确保 Kafka：环境变量 → 已运行 → Docker → WSL → 禁用，不阻塞 dsh 启动。
    void this.bootstrapKafka()
  }

  private async bootstrapKafka(): Promise<void> {
    try {
      this.kafkaState = await ensureKafka({ brokers: DEFAULT_BROKERS })
    } catch (error) {
      this.kafkaState = {
        ready: false,
        brokers: [...DEFAULT_BROKERS],
        reason: 'unavailable',
        failure: 'start-failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 查询 a2a-host 监听状态和 Kafka 就绪状态。
   * a2a-host 未加载时报告 hostRunning: false；Kafka 由启动时的 background 任务确保，
   * 状态可以是 starting（探测/启动中）、ready、unavailable。
   * @returns 当前的 a2a 服务状态快照。
   */
  @Remote('status')
  async status(): Promise<A2AStatus> {
    const host = this.ctx.get('a2aHost')
    const hostRunning = host?.listening ?? false
    const hostPort = host?.port ?? 0
    const state = this.kafkaState
    // 后台任务仍在跑，但可能已经就绪：再做一次轻量探测定相。
    let kafkaReady = state?.ready ?? false
    if (state === undefined || !state.ready) {
      try {
        kafkaReady = await isKafkaRunning(DEFAULT_BROKERS)
      } catch { /* 探测失败按未就绪处理 */ }
    }
    const failed = failureOf(state)
    return {
      hostRunning,
      hostPort,
      kafkaPhase: state === undefined ? 'starting' : (kafkaReady ? 'ready' : 'unavailable'),
      kafkaReady,
      kafkaBrokers: [...(state?.brokers ?? DEFAULT_BROKERS)],
      // 本次探测已可达时不再回放历史失败，避免「已恢复但显示故障原因」。
      kafkaFailure: kafkaReady ? null : failed.failure,
      kafkaDiagnostic: kafkaReady ? '' : failed.diagnostic,
    }
  }
}

export default A2AStatusGateway
