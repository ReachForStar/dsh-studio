/**
 * a2a 服务状态查询的 wire 词汇。仅包含 a2a-host 监听状态和 Kafka 可达性，
 * 不携带任何密钥或端点 URL。
 * @module @reachforstar/dsh-a2a-status/types
 */

/** Kafka 就绪阶段：启动探测中 / 已就绪 / 不可用。 */
export type KafkaPhase = 'starting' | 'ready' | 'unavailable'

/** a2a-host 和 Kafka 的运行时状态快照。 */
export interface A2AStatus {
  /** a2a-host 监听器是否已绑定。 */
  hostRunning: boolean
  /** a2a-host 绑定的 TCP 端口；未运行时为 0。 */
  hostPort: number
  /** Kafka 就绪阶段。 */
  kafkaPhase: KafkaPhase
  /** Kafka 集群是否可达（就绪时 true）。 */
  kafkaReady: boolean
  /** 探测的 broker 地址列表。 */
  kafkaBrokers: string[]
  /** Kafka 未就绪时的原因描述；就绪时为空字符串。 */
  kafkaReason: string
}