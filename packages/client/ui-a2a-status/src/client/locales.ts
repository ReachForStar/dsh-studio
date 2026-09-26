/**
 * a2a 服务状态指示器页面文案。中文为产品文案，英文镜像。
 */

/** 中文产品文案，键集来源。 */
export const zh = {
  nav: 'A2A 服务',
  description: '查询 A2A 主机和 Kafka 的运行状态。服务不可用时，A2A 相关入口将隐藏。',
  hostStatus: 'A2A 主机',
  hostRunning: '运行中（端口 {port}）',
  hostStopped: '未运行',
  kafkaStatus: 'Kafka',
  kafkaReady: '就绪',
  kafkaUnavailable: '不可用',
  loading: '查询中…',
  loadFailed: '查询状态失败。',
  retry: '重试',
  entryHidden: 'A2A 服务不可用，相关入口已隐藏。',
} satisfies Record<string, string>

/** 页面文案键，由中文字典推导。 */
export type A2aStatusLocaleKey = keyof typeof zh

/** 英文镜像，键集与中文对齐。 */
export const en = {
  nav: 'A2A Service',
  description: 'Query A2A host and Kafka runtime status. A2A entries are hidden when the service is unavailable.',
  hostStatus: 'A2A Host',
  hostRunning: 'Running (port {port})',
  hostStopped: 'Not running',
  kafkaStatus: 'Kafka',
  kafkaReady: 'Ready',
  kafkaUnavailable: 'Unavailable',
  loading: 'Querying…',
  loadFailed: 'Failed to query status.',
  retry: 'Retry',
  entryHidden: 'A2A service unavailable; related entries hidden.',
} satisfies Record<A2aStatusLocaleKey, string>