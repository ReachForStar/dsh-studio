/**
 * a2a 服务状态查询的 wire 词汇。仅包含 a2a-host 监听状态和 Kafka 可达性，
 * 不携带任何密钥或端点 URL。
 * @module @reachforstar/dsh-a2a-status/types
 */

/** Kafka 就绪阶段：启动探测中 / 已就绪 / 不可用。 */
export type KafkaPhase = 'starting' | 'ready' | 'unavailable'

/**
 * Kafka 未就绪的类别，供客户端从自己的文案字典取文案。
 * `no-runtime` 无 Docker 也无 WSL；`start-failed` 启动命令失败；`not-listening` 命令执行但 broker 未监听。
 */
export type KafkaFailure = 'no-runtime' | 'start-failed' | 'not-listening'

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
  /** Kafka 未就绪的类别；就绪或探测中时为 null。 */
  kafkaFailure: KafkaFailure | null
  /** Kafka 未就绪时的原始诊断文本（启动命令的退出码与 stderr）；无细节时为空字符串。 */
  kafkaDiagnostic: string
}
