import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  ensureKafka,
  startKafkaViaDocker,
  startKafkaViaWsl,
} from '../src/kafka-detect.ts'
import type { CommandRunner } from '../src/kafka-detect.ts'

/** 记录调用并按需失败的假执行器。 */
function recorder(failWith?: string): { runner: CommandRunner; calls: { program: string; args: readonly string[]; input: string }[] } {
  const calls: { program: string; args: readonly string[]; input: string }[] = []
  const runner: CommandRunner = async (program, args, input) => {
    calls.push({ program, args, input })
    if (failWith !== undefined) throw new Error(failWith)
  }
  return { runner, calls }
}

/** 任何端口都不监听，让探测稳定走“未就绪”。 */
const NO_BROKERS = ['127.0.0.1:1'] as const

describe('startKafkaViaDocker', () => {
  it('经 stdin 传 compose 内容，并固定项目名', async () => {
    const { runner, calls } = recorder()
    await startKafkaViaDocker(undefined, runner)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.program).toBe('docker')
    // `-f -` 让 docker 从 stdin 读配置：打包后 compose 位于 app.asar 内，路径读不到。
    expect(call?.args).toEqual(['compose', '-p', 'kafka', '-f', '-', 'up', '-d'])
    expect(call?.input).toContain('services:')
    expect(call?.input).toContain('apache/kafka:3.9.0')
  })

  it('stdin 内容与包内 compose 文件逐字一致', async () => {
    const { runner, calls } = recorder()
    const composePath = new URL('../infra/kafka/docker-compose.yml', import.meta.url).pathname
    await startKafkaViaDocker(composePath, runner)
    expect(calls[0]?.input).toBe(readFileSync(composePath, 'utf8'))
  })

  it('执行器拒绝时把错误抛给调用方', async () => {
    const { runner } = recorder('docker compose 退出码 1')
    await expect(startKafkaViaDocker(undefined, runner)).rejects.toThrow('docker compose 退出码 1')
  })
})

describe('startKafkaViaWsl', () => {
  it('把 compose 内容写进 wsl 进程的 stdin，命令里不再出现文件路径', async () => {
    const { runner, calls } = recorder()
    await startKafkaViaWsl(undefined, runner)
    const call = calls[0]
    expect(call?.program).toBe('wsl')
    expect(call?.args).toEqual(['-e', 'bash', '-lc', 'docker compose -p kafka -f - up -d'])
    expect(call?.args.join(' ')).not.toContain('.yml')
    expect(call?.input).toContain('services:')
  })
})

describe('ensureKafka', () => {
  it('环境变量给出 broker 时直接采用，不探测也不启动', async () => {
    const { runner, calls } = recorder()
    const result = await ensureKafka({ envBootstrap: '10.0.0.1:9092, 10.0.0.2:9093', runner, brokers: NO_BROKERS })
    expect(result).toEqual({ ready: true, brokers: ['10.0.0.1:9092', '10.0.0.2:9093'], reason: 'env-override' })
    expect(calls).toHaveLength(0)
  })

  it('跳过 Docker 与 WSL 时报告不可用，并按探测列表回传', async () => {
    const result = await ensureKafka({ envBootstrap: '', brokers: NO_BROKERS, skipDocker: true, skipWsl: true })
    // 未尝试任何启动路径，失败类别归为“无可用运行时”。
    expect(result).toEqual({ ready: false, brokers: [...NO_BROKERS], reason: 'unavailable', failure: 'no-runtime' })
    expect(result.detail).toBeUndefined()
  })

  it('Docker 启动命令失败时把失败原因留在 detail 里', async () => {
    const { runner } = recorder('docker compose -p kafka -f - up -d 退出码 1：no such volume')
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipWsl: true,
      dockerAvailable: async () => true,
    })
    expect(result.ready).toBe(false)
    expect(result.reason).toBe('unavailable')
    expect(result.failure).toBe('start-failed')
    expect(result.detail).toContain('退出码 1')
  })

  it('Docker 不可用时归为无可用运行时', async () => {
    const { runner, calls } = recorder()
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipWsl: true,
      dockerAvailable: async () => false,
    })
    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ ready: false, failure: 'no-runtime' })
  })

  it('WSL 启动命令失败时同样留下原因', async () => {
    const { runner, calls } = recorder('wsl docker compose 退出码 127：docker: not found')
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipDocker: true,
      wslAvailable: async () => true,
    })
    expect(calls[0]?.program).toBe('wsl')
    expect(result).toMatchObject({ ready: false, reason: 'unavailable', failure: 'start-failed' })
    expect(result.detail).toContain('退出码 127')
  })
})
