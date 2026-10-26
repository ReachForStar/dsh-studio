import { afterEach, describe, expect, it, vi } from 'vitest'

import { Context } from '@deepseek-ai/cordis'

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
 * 绕过构造函数直接使用原型方法，用于只关心快照计算、不关心生命周期的用例。
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

/** 后台启动任务的引用；每个用例创建的 Context 在结束时释放。 */
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  ensureKafka.mockReset()
  isKafkaRunning.mockReset()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * 用真实 cordis Context 构造网关，从而覆盖构造函数与后台启动任务。
 * @returns 网关实例与它所属的 Context。
 */
function mounted(): { gateway: InstanceType<typeof A2AStatusGateway>; ctx: Context } {
  const ctx = new Context()
  contexts.push(ctx)
  return { gateway: new A2AStatusGateway(ctx), ctx }
}

describe('A2AStatusGateway 生命周期', () => {
  it('构造时注册服务并后台确保 Kafka', async () => {
    ensureKafka.mockResolvedValue({ ready: true, brokers: ['127.0.0.1:9092'], reason: 'already-running' })
    const { gateway: instance, ctx } = mounted()
    expect(instance.name).toBe('a2aStatusGateway')
    expect(ctx.get('a2aStatusGateway')).toBeInstanceOf(A2AStatusGateway)
    await vi.waitFor(() => { expect(ensureKafka).toHaveBeenCalledTimes(1) })
    isKafkaRunning.mockResolvedValue(true)
    await expect(instance.status()).resolves.toMatchObject({ kafkaPhase: 'ready', kafkaFailure: null })
  })

  it('后台确保抛错时记为启动失败并保留消息', async () => {
    ensureKafka.mockRejectedValue(new Error('docker socket 不可读'))
    const { gateway: instance } = mounted()
    await vi.waitFor(() => { expect(ensureKafka).toHaveBeenCalledTimes(1) })
    isKafkaRunning.mockResolvedValue(false)
    await expect(instance.status()).resolves.toMatchObject({
      kafkaPhase: 'unavailable',
      kafkaFailure: 'start-failed',
      kafkaDiagnostic: 'docker socket 不可读',
    })
  })

  it('后台抛出非 Error 值时也转成文本', async () => {
    ensureKafka.mockRejectedValue('纯字符串失败')
    const { gateway: instance } = mounted()
    await vi.waitFor(() => { expect(ensureKafka).toHaveBeenCalledTimes(1) })
    isKafkaRunning.mockResolvedValue(false)
    await expect(instance.status()).resolves.toMatchObject({ kafkaDiagnostic: '纯字符串失败' })
  })

  it('后台任务完成前查询报 starting，且不带诊断', async () => {
    let release: (value: KafkaEnsureResult) => void = () => {}
    ensureKafka.mockReturnValue(new Promise<KafkaEnsureResult>((resolve) => { release = resolve }))
    const { gateway: instance } = mounted()
    isKafkaRunning.mockResolvedValue(false)
    await expect(instance.status()).resolves.toMatchObject({
      kafkaPhase: 'starting',
      kafkaFailure: 'no-runtime',
      kafkaDiagnostic: '',
    })
    release({ ready: false, brokers: ['127.0.0.1:9092'], reason: 'unavailable', failure: 'no-runtime' })
  })
})

describe('A2AStatusGateway.status', () => {
  it('a2aHost 未挂载时报告 hostRunning: false 与端口 0', async () => {
    isKafkaRunning.mockResolvedValue(true)
    expect(await gateway(undefined).status()).toMatchObject({ hostRunning: false, hostPort: 0 })
  })

  it('a2aHost 已监听时回传端口', async () => {
    isKafkaRunning.mockResolvedValue(true)
    const snap = await gateway({ listening: true, port: 9310 }).status()
    expect(snap).toMatchObject({ hostRunning: true, hostPort: 9310 })
  })

  it('a2aHost 未绑定端口时端口回落为 0', async () => {
    isKafkaRunning.mockResolvedValue(true)
    const snap = await gateway({ listening: true, port: undefined }).status()
    expect(snap).toMatchObject({ hostRunning: true, hostPort: 0 })
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

  it('结果缺少 failure 时按无可用运行时处理', async () => {
    isKafkaRunning.mockResolvedValue(false)
    const instance = gateway(undefined, { ready: false, brokers: ['127.0.0.1:9092'], reason: 'unavailable' })
    expect(await instance.status()).toMatchObject({ kafkaFailure: 'no-runtime' })
  })

  it('后台已判定未就绪但本次探测成功时按 ready 收尾', async () => {
    const instance = gateway(undefined, { ready: false, brokers: ['127.0.0.1:9092'], reason: 'unavailable', failure: 'not-listening' })
    isKafkaRunning.mockResolvedValue(true)
    expect(await instance.status()).toMatchObject({ kafkaPhase: 'ready', kafkaReady: true, kafkaFailure: null })
  })

  it('探测本身抛错时按未就绪处理', async () => {
    isKafkaRunning.mockRejectedValue(new Error('探测异常'))
    const instance = gateway(undefined, { ready: false, brokers: ['127.0.0.1:9092'], reason: 'unavailable', failure: 'start-failed' })
    expect(await instance.status()).toMatchObject({ kafkaReady: false, kafkaFailure: 'start-failed' })
  })
})
