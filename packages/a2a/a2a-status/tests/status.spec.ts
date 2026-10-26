import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { KafkaEnsureResult } from '@reachforstar/dsh-a2a-host/kafka-detect'
import type { A2AStatus } from '../src/types.ts'

/** 每个用例重设 ensureKafka 的返回值；vi.mock 被提升，静态导入的网关模块拿到的是这份替身。 */
const ensureKafka = vi.fn<() => Promise<KafkaEnsureResult>>()
const isKafkaRunning = vi.fn<() => Promise<boolean>>()

vi.mock('@reachforstar/dsh-a2a-host/kafka-detect', () => ({
  ensureKafka: () => ensureKafka(),
  isKafkaRunning: () => isKafkaRunning(),
}))

const { A2AStatusGateway } = await import('../src/index.ts')

/** a2aHost 的最小可见面：网关只读 listening 与 port。 */
interface HostFace {
  listening: boolean
  port: number | undefined
}

/**
 * 绕过构造函数直接使用原型方法，避免为一个纯查询方法装配整个 cordis 图。
 * ctx 只提供 get，a2aHost 缺失即代表该插件未挂载。
 */
interface GatewayUnderTest {
  ctx: { get(name: string): HostFace | undefined }
  kafkaState?: KafkaEnsureResult
  status(): Promise<A2AStatus>
}

/**
 * 造一个只填了 ctx 与可选 kafkaState 的网关。
 * @param host - a2aHost 替身；undefined 表示未挂载。
 * @param state - 启动探测结果；undefined 表示后台任务尚未完成。
 * @returns 可调用 status() 的实例。
 */
function gateway(host: HostFace | undefined, state?: KafkaEnsureResult): GatewayUnderTest {
  const instance = Object.create(A2AStatusGateway.prototype) as GatewayUnderTest
  instance.ctx = { get: (name: string) => (name === 'a2aHost' ? host : undefined) }
  if (state !== undefined) instance.kafkaState = state
  return instance
}

describe('A2AStatusGateway.status', () => {
  beforeEach(() => {
    ensureKafka.mockReset()
    isKafkaRunning.mockReset()
  })

  it('a2aHost 未挂载时报告 hostRunning: false 与端口 0', async () => {
    isKafkaRunning.mockResolvedValue(true)
    expect(await gateway(undefined).status()).toMatchObject({ hostRunning: false, hostPort: 0, kafkaPhase: 'starting' })
  })

  it('a2aHost 已监听时回传端口', async () => {
    isKafkaRunning.mockResolvedValue(true)
    const snap = await gateway({ listening: true, port: 9310 }).status()
    expect(snap).toMatchObject({ hostRunning: true, hostPort: 9310 })
  })

  it('就绪时不回放历史失败原因', async () => {
    const instance = gateway(undefined, { ready: true, brokers: ['127.0.0.1:9092'], reason: 'already-running' })
    const snap = await instance.status()
    expect(snap).toMatchObject({ kafkaPhase: 'ready', kafkaReady: true, kafkaFailure: null, kafkaDiagnostic: '' })
  })

  it('启动失败时回传类别与原始诊断', async () => {
    isKafkaRunning.mockResolvedValue(false)
    const instance = gateway(undefined, {
      ready: false,
      brokers: ['127.0.0.1:9092'],
      reason: 'unavailable',
      failure: 'start-failed',
      detail: 'docker compose 退出码 1：no such file',
    })
    const snap = await instance.status()
    expect(snap).toMatchObject({
      kafkaPhase: 'unavailable',
      kafkaReady: false,
      kafkaFailure: 'start-failed',
      kafkaDiagnostic: 'docker compose 退出码 1：no such file',
    })
  })

  it('启动命令执行但未监听时归为 not-listening，且不带诊断细节', async () => {
    isKafkaRunning.mockResolvedValue(false)
    const instance = gateway(undefined, {
      ready: false,
      brokers: ['127.0.0.1:9092'],
      reason: 'unavailable',
      failure: 'not-listening',
    })
    expect(await instance.status()).toMatchObject({ kafkaFailure: 'not-listening', kafkaDiagnostic: '' })
  })

  it('后台尚未出结果时报 starting，且失败类别为无可用运行时', async () => {
    isKafkaRunning.mockResolvedValue(false)
    expect(await gateway(undefined).status()).toMatchObject({
      kafkaPhase: 'starting',
      kafkaReady: false,
      kafkaFailure: 'no-runtime',
    })
  })
})
