import { createServer, type Server } from 'node:net'
import { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { spawn } from 'node:child_process'

import {
  ensureKafka,
  isDockerAvailable,
  isKafkaRunning,
  isWslAvailable,
  startKafkaViaDocker,
  startKafkaViaWsl,
} from '../src/kafka-detect.ts'
import type { CommandRunner, KafkaBrokers } from '../src/kafka-detect.ts'

// spawn 只在探测真实 Docker / WSL 的子进程里用到；把它换成可控替身，其余模块保持原样。
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}))

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

/** 固定返回给定值的探测。 */
const probeOf = (value: boolean) => async (): Promise<boolean> => value

/** 依次返回给定值的探测，用于“先失败后成功”的等待分支。 */
function probeSequence(...values: boolean[]): { probe: (brokers: KafkaBrokers) => Promise<boolean>; calls: number } {
  const state = { calls: 0 }
  const probe = async (): Promise<boolean> => {
    const value = values[Math.min(state.calls, values.length - 1)] ?? false
    state.calls += 1
    return value
  }
  return { probe, get calls() { return state.calls } }
}

/** 起一个真实监听套接字，返回其端口与关闭函数。 */
async function listeningPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('测试服务器未绑定端口')
  return {
    port: address.port,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
  }
}

/** 造一个能被监听器驱动的假子进程。 */
function fakeChild(): ChildProcess {
  return new ChildProcess()
}

/**
 * 造一个带可写 stderr 与 stdin 的假子进程，用于驱动默认执行器的错误收集。
 * stderr 单独返回，避免在用例里对可空的 `child.stderr` 取值。
 * @returns 子进程、stderr 流与记录收到的 stdin 内容。
 */
function fakeChildWithStreams(): { child: ChildProcess; stderr: PassThrough; stdin: string[] } {
  const child = new ChildProcess()
  const stdin: string[] = []
  const stderr = new PassThrough()
  const input = new PassThrough()
  input.on('data', (chunk: Buffer) => { stdin.push(chunk.toString()) })
  Object.defineProperty(child, 'stderr', { value: stderr, configurable: true })
  Object.defineProperty(child, 'stdin', { value: input, configurable: true })
  return { child, stderr, stdin }
}

afterEach(() => {
  vi.mocked(spawn).mockReset()
  vi.useRealTimers()
})

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

  it('执行器拒绝时把错误抛给调用方', async () => {
    const { runner } = recorder('wsl docker compose 退出码 127')
    await expect(startKafkaViaWsl(undefined, runner)).rejects.toThrow('退出码 127')
  })
})

describe('isKafkaRunning', () => {
  it('端口真的在监听时为 true', async () => {
    const { port, close } = await listeningPort()
    try {
      expect(await isKafkaRunning([`127.0.0.1:${port}`])).toBe(true)
    } finally {
      await close()
    }
  })

  it('连接被拒时为 false', async () => {
    expect(await isKafkaRunning(NO_BROKERS)).toBe(false)
  })

  it('连接超时按不可达处理', async () => {
    // 路由到保留地址上的黑洞端口：SYN 无应答，触发 500ms 超时分支。
    expect(await isKafkaRunning(['192.0.2.1:9092'])).toBe(false)
  })

  it('缺少主机、缺少端口或端口非法时直接判定不可达，不发起连接', async () => {
    expect(await isKafkaRunning([':9092'])).toBe(false)
    expect(await isKafkaRunning(['127.0.0.1'])).toBe(false)
    expect(await isKafkaRunning(['127.0.0.1:not-a-port'])).toBe(false)
    expect(await isKafkaRunning(['127.0.0.1:0'])).toBe(false)
  })

  it('任一 broker 可达即为 true', async () => {
    const { port, close } = await listeningPort()
    try {
      expect(await isKafkaRunning([...NO_BROKERS, `127.0.0.1:${port}`])).toBe(true)
    } finally {
      await close()
    }
  })
})

describe('isDockerAvailable', () => {
  it('docker info 退出码为 0 时为 true', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const settled = isDockerAvailable()
    child.emit('exit', 0, null)
    await expect(settled).resolves.toBe(true)
    child.removeAllListeners()
  })

  it('docker info 非零退出码时为 false', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const settled = isDockerAvailable()
    child.emit('exit', 1, null)
    await expect(settled).resolves.toBe(false)
    child.removeAllListeners()
  })

  it('docker 不在 PATH 时按不可用处理', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const settled = isDockerAvailable()
    child.emit('error', new Error('spawn docker ENOENT'))
    await expect(settled).resolves.toBe(false)
    child.removeAllListeners()
  })
})

describe('isWslAvailable', () => {
  it('非 Windows 平台恒为 false，且不启动子进程', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await expect(isWslAvailable()).resolves.toBe(false)
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })

  it('Windows 上退出码为 0 时为 true', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const settled = isWslAvailable()
    child.emit('exit', 0, null)
    await expect(settled).resolves.toBe(true)
    child.removeAllListeners()
  })

  it('Windows 上非零退出码时为 false', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const settled = isWslAvailable()
    child.emit('exit', 1, null)
    await expect(settled).resolves.toBe(false)
    child.removeAllListeners()
  })

  it('Windows 上 wsl 不可执行时为 false', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const settled = isWslAvailable()
    child.emit('error', new Error('spawn wsl ENOENT'))
    await expect(settled).resolves.toBe(false)
    child.removeAllListeners()
  })
})

describe('ensureKafka', () => {
  it('环境变量给出 broker 时直接采用，不探测也不启动', async () => {
    const { runner, calls } = recorder()
    const result = await ensureKafka({ envBootstrap: '10.0.0.1:9092, 10.0.0.2:9093', runner, brokers: NO_BROKERS })
    expect(result).toEqual({ ready: true, brokers: ['10.0.0.1:9092', '10.0.0.2:9093'], reason: 'env-override' })
    expect(calls).toHaveLength(0)
  })

  it('环境变量只有分隔符时忽略它，继续走后续探测', async () => {
    const { runner } = recorder()
    const result = await ensureKafka({
      envBootstrap: ' , , ',
      runner,
      brokers: NO_BROKERS,
      probe: probeOf(false),
      dockerAvailable: probeOf(false),
      skipWsl: true,
    })
    expect(result).toMatchObject({ ready: false, failure: 'no-runtime' })
  })

  it('读取环境变量默认值：未显式传入时用 A2A_BUS_BOOTSTRAP', async () => {
    const previous = process.env.A2A_BUS_BOOTSTRAP
    process.env.A2A_BUS_BOOTSTRAP = '10.1.0.1:9092'
    try {
      const result = await ensureKafka({ brokers: NO_BROKERS })
      expect(result).toMatchObject({ ready: true, reason: 'env-override', brokers: ['10.1.0.1:9092'] })
    } finally {
      if (previous === undefined) delete process.env.A2A_BUS_BOOTSTRAP
      else process.env.A2A_BUS_BOOTSTRAP = previous
    }
  })

  it('已运行时不尝试启动', async () => {
    const { runner, calls } = recorder()
    const result = await ensureKafka({ envBootstrap: '', brokers: NO_BROKERS, runner, probe: probeOf(true) })
    expect(result).toEqual({ ready: true, brokers: [...NO_BROKERS], reason: 'already-running' })
    expect(calls).toHaveLength(0)
  })

  it('跳过 Docker 与 WSL 时报告不可用且带默认 broker 列表', async () => {
    const result = await ensureKafka({ envBootstrap: '', skipDocker: true, skipWsl: true, probe: probeOf(false) })
    // 未尝试任何启动路径，失败类别归为“无可用运行时”。
    expect(result).toEqual({
      ready: false,
      brokers: ['127.0.0.1:9092', '127.0.0.1:9093', '127.0.0.1:9094'],
      reason: 'unavailable',
      failure: 'no-runtime',
    })
    expect(result.detail).toBeUndefined()
  })

  it('Docker 拉起后探测到监听即为 started-via-docker', async () => {
    const { runner, calls } = recorder()
    // 第 2 步（已运行探测）失败，Docker 启动后的等待首探成功。
    const sequence = probeSequence(false, true)
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipWsl: true,
      dockerAvailable: probeOf(true),
      probe: sequence.probe,
      startupTimeoutMs: 0,
    })
    expect(result).toEqual({ ready: true, brokers: [...NO_BROKERS], reason: 'started-via-docker' })
    expect(calls[0]?.program).toBe('docker')
  })

  it('Docker 启动命令失败时留下退出码与 stderr', async () => {
    const { runner } = recorder('docker compose -p kafka -f - up -d 退出码 1：no such volume')
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipWsl: true,
      dockerAvailable: probeOf(true),
      probe: probeOf(false),
    })
    expect(result.ready).toBe(false)
    expect(result.failure).toBe('start-failed')
    expect(result.detail).toContain('退出码 1')
  })

  it('Docker 命令成功但 broker 未在时限内监听时为 not-listening', async () => {
    const { runner } = recorder()
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipWsl: true,
      dockerAvailable: probeOf(true),
      probe: probeOf(false),
      startupTimeoutMs: 0,
    })
    expect(result).toMatchObject({ ready: false, failure: 'not-listening' })
    expect(result.detail).toContain('0 秒内均未监听')
  })

  it('等待窗口内探测转好时按 Docker 成功收尾', async () => {
    vi.useFakeTimers()
    const { runner } = recorder()
    // 首次探测（第 2 步）失败，Docker 启动后的第一次探测仍失败，轮询时成功。
    const sequence = probeSequence(false, false, true)
    const settled = ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipWsl: true,
      dockerAvailable: probeOf(true),
      probe: sequence.probe,
      startupTimeoutMs: 5000,
    })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(settled).resolves.toMatchObject({ ready: true, reason: 'started-via-docker' })
  })

  it('Docker 不可用时归为无可用运行时', async () => {
    const { runner, calls } = recorder()
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipWsl: true,
      dockerAvailable: probeOf(false),
      probe: probeOf(false),
    })
    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ ready: false, failure: 'no-runtime' })
  })

  it('Docker 失败后仍可回退 WSL，且不会把 already-running 误认为启动成功', async () => {
    const { runner } = recorder()
    // 第 2 步失败、Docker 等待期失败、WSL 等待期成功。
    const sequence = probeSequence(false, false, true)
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      dockerAvailable: probeOf(true),
      wslAvailable: probeOf(true),
      probe: sequence.probe,
      startupTimeoutMs: 0,
    })
    expect(result).toMatchObject({ ready: true, reason: 'started-via-wsl' })
  })

  it('WSL 分支能真正启动并报告 started-via-wsl', async () => {
    const { runner, calls } = recorder()
    // 第 2 步探测失败；之后 Docker 分支被跳过，WSL 启动后探测成功。
    const sequence = probeSequence(false, true)
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipDocker: true,
      wslAvailable: probeOf(true),
      probe: sequence.probe,
      startupTimeoutMs: 0,
    })
    expect(result).toEqual({ ready: true, brokers: [...NO_BROKERS], reason: 'started-via-wsl' })
    expect(calls[0]?.program).toBe('wsl')
  })

  it('WSL 启动命令失败时留下原因', async () => {
    const { runner, calls } = recorder('wsl docker compose 退出码 127：docker: not found')
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipDocker: true,
      wslAvailable: probeOf(true),
      probe: probeOf(false),
    })
    expect(calls[0]?.program).toBe('wsl')
    expect(result).toMatchObject({ ready: false, reason: 'unavailable', failure: 'start-failed' })
    expect(result.detail).toContain('退出码 127')
  })

  it('WSL 命令成功但 broker 未监听时为 not-listening 且带 wsl 前缀', async () => {
    const { runner } = recorder()
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipDocker: true,
      wslAvailable: probeOf(true),
      probe: probeOf(false),
      startupTimeoutMs: 0,
    })
    expect(result).toMatchObject({ ready: false, failure: 'not-listening' })
    expect(result.detail).toContain('wsl docker compose 已执行')
  })

  it('非 Error 的抛出值也转成文本', async () => {
    const runner: CommandRunner = async () => { throw '字符串错误' }
    const result = await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipWsl: true,
      dockerAvailable: probeOf(true),
      probe: probeOf(false),
    })
    expect(result).toMatchObject({ failure: 'start-failed', detail: '字符串错误' })
  })

  it('默认 compose 路径指向包内文件', async () => {
    const { runner, calls } = recorder()
    await ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipWsl: true,
      dockerAvailable: probeOf(true),
      probe: probeOf(false),
      startupTimeoutMs: 0,
    })
    expect(calls[0]?.input).toContain('kafka-1:')
  })
})

describe('默认执行器（经 startKafkaViaDocker 驱动）', () => {
  it('退出码 0 时兑现，并把 compose 内容写进子进程 stdin', async () => {
    const { child, stdin } = fakeChildWithStreams()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const settled = startKafkaViaDocker()
    child.emit('exit', 0, null)
    await expect(settled).resolves.toBeUndefined()
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'docker',
      ['compose', '-p', 'kafka', '-f', '-', 'up', '-d'],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
    )
    expect(stdin.join('')).toContain('apache/kafka:3.9.0')
    child.removeAllListeners()
  })

  it('非零退出码时把 stderr 并入错误文本', async () => {
    const { child, stderr } = fakeChildWithStreams()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const settled = startKafkaViaDocker()
    stderr.emit('data', 'no such volume\n')
    child.emit('exit', 1, null)
    await expect(settled).rejects.toThrow('退出码 1：no such volume')
    child.removeAllListeners()
  })

  it('非零退出码但 stderr 为空时不带冒号尾巴', async () => {
    const { child, stderr } = fakeChildWithStreams()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const settled = startKafkaViaDocker()
    stderr.emit('data', '   \n')
    child.emit('exit', 2, null)
    await expect(settled).rejects.toThrow('退出码 2')
    child.removeAllListeners()
  })

  it('子进程无法启动时把错误转交调用方', async () => {
    const { child } = fakeChildWithStreams()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const settled = startKafkaViaDocker()
    child.emit('error', new Error('spawn docker ENOENT'))
    await expect(settled).rejects.toThrow('spawn docker ENOENT')
    child.removeAllListeners()
  })
})

describe('waitForBrokers 的退避循环', () => {
  it('退避后仍未就绪时返回 false 并继续走降级路径', async () => {
    vi.useFakeTimers()
    const { runner } = recorder()
    // 第 2 步、Docker 首探、退避后复探全部失败：覆盖 while 内 205 行的失败分支。
    const result = ensureKafka({
      envBootstrap: '',
      brokers: NO_BROKERS,
      runner,
      skipWsl: true,
      dockerAvailable: probeOf(true),
      probe: probeOf(false),
      startupTimeoutMs: 1500,
    })
    await vi.advanceTimersByTimeAsync(3000)
    await expect(result).resolves.toMatchObject({ ready: false, failure: 'not-listening' })
  })
})
