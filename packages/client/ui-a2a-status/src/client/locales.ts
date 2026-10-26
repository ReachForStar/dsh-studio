/**
 * a2a 服务状态指示器页面文案。中文为产品文案，英文镜像。
 */

/** 中文产品文案，键集来源。 */
export const zh = {
  nav: 'A2A 服务',
  description: '查询 A2A 主机和 Kafka 的运行状态',
  hostStatus: 'A2A 主机',
  hostRunning: '运行中（端口 {port}）',
  hostStopped: '未运行',
  kafkaStatus: 'Kafka',
  kafkaStarting: '启动中…',
  kafkaReady: '就绪',
  kafkaUnavailable: '不可用',
  kafkaNoRuntime: '本机未找到 Docker 或 WSL，且未设置 A2A_BUS_BOOTSTRAP。',
  kafkaStartFailed: 'Kafka 启动命令执行失败。',
  kafkaNotListening: '启动命令已执行，但 broker 未在预期时间内监听。',
  kafkaBrokers: '探测地址',
  kafkaDiagnostic: '失败详情',
  loading: '查询中…',
  loadFailed: '查询状态失败。',
  retry: '重试',
} satisfies Record<string, string>

/** 页面文案键，由中文字典推导。 */
export type A2aStatusLocaleKey = keyof typeof zh

/** 英文镜像，键集与中文对齐。 */
export const en = {
  nav: 'A2A Service',
  description: 'Query A2A host and Kafka runtime status.',
  hostStatus: 'A2A Host',
  hostRunning: 'Running (port {port})',
  hostStopped: 'Not running',
  kafkaStatus: 'Kafka',
  kafkaStarting: 'Starting…',
  kafkaReady: 'Ready',
  kafkaUnavailable: 'Unavailable',
  kafkaNoRuntime: 'No Docker or WSL found on this host, and A2A_BUS_BOOTSTRAP is unset.',
  kafkaStartFailed: 'The Kafka start command failed.',
  kafkaNotListening: 'The start command ran, but no broker listened within the expected time.',
  kafkaBrokers: 'Probed addresses',
  kafkaDiagnostic: 'Failure detail',
  loading: 'Querying…',
  loadFailed: 'Failed to query status.',
  retry: 'Retry',
} satisfies Record<A2aStatusLocaleKey, string>
