/**
 * Host Remote 网关：查询 a2a-host 监听状态和 Kafka 可达性，供前端状态指示器
 * 和入口显隐消费。a2a-host 是可选服务，未加载时报告 hostRunning: false。
 * @module @reachforstar/dsh-a2a-status
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { isKafkaRunning } from '@reachforstar/dsh-a2a-host/kafka-detect'
import type { A2AStatus } from './types.ts'

export type * from './types.ts'

// 引入 a2a-host 的 Context.a2aHost 类型增强，使 ctx.get('a2aHost') 返回精确类型。
import type {} from '@reachforstar/dsh-a2a-host'

/** 默认探测的 Kafka broker 地址。 */
const DEFAULT_BROKERS: readonly string[] = ['127.0.0.1:9092', '127.0.0.1:9093', '127.0.0.1:9094']

/** a2a 服务状态查询的 Host Remote 网关，wire namespace 为 `a2a`。 */
export class A2AStatusGateway extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'a2aStatusGateway', { namespace: 'a2a' })
  }

  /**
   * 查询 a2a-host 监听状态和 Kafka 可达性。
   * a2a-host 未加载时报告 hostRunning: false；Kafka 用 TCP 探测，不启动。
   * @returns 当前的 a2a 服务状态快照。
   */
  @Remote('status')
  async status(): Promise<A2AStatus> {
    const host = this.ctx.get('a2aHost')
    const hostRunning = host?.listening ?? false
    const hostPort = host?.port ?? 0
    let kafkaReady = false
    let kafkaReason = ''
    try {
      kafkaReady = await isKafkaRunning(DEFAULT_BROKERS)
      kafkaReason = kafkaReady ? '' : '未检测到运行中的 Kafka broker'
    } catch (error) {
      kafkaReason = `Kafka 探测出错: ${error instanceof Error ? error.message : String(error)}`
    }
    return {
      hostRunning,
      hostPort,
      kafkaReady,
      kafkaBrokers: [...DEFAULT_BROKERS],
      kafkaReason,
    }
  }
}

export default A2AStatusGateway