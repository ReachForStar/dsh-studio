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
  loading: 'Querying…',
  loadFailed: 'Failed to query status.',
  retry: 'Retry',
} satisfies Record<A2aStatusLocaleKey, string>
