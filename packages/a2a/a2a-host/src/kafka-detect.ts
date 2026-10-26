/**
 * Kafka 基础设施检测与启动：端口探测 → Docker → WSL → 环境变量自定义 → 禁用。
 * @module
 */

import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

import { dirname, join } from 'node:path'

/** Kafka broker 地址列表。 */
export type KafkaBrokers = readonly string[]

/**
 * broker 可达性探测。
 * @param brokers - 待探测的 `host:port` 列表。
 * @returns 任一 broker 可连时为 true。
 */
export type BrokerProbe = (brokers: KafkaBrokers) => Promise<boolean>

/** ensureKafka 的结果。 */
export interface KafkaEnsureResult {
  /** Kafka 是否已就绪（检测到运行或成功启动）。 */
  ready: boolean
  /** 就绪时实际可用的 broker 地址列表。 */
  brokers: KafkaBrokers
  /** 未就绪时的原因，供前端展示。 */
  reason?: 'already-running' | 'started-via-docker' | 'started-via-wsl' | 'env-override' | 'unavailable'
  /** 未就绪的类别：无可用运行时 / 启动命令失败 / 启动后 broker 未监听。 */
  failure?: 'no-runtime' | 'start-failed' | 'not-listening'
  /** 未就绪时的诊断细节（启动命令的 stderr 等）；比 reason 更能指出失败点。 */
  detail?: string
}

/**
 * 启动命令的执行器；stdin 承载 compose 内容。
 * @param program - 可执行文件名。
 * @param args - 参数向量。
 * @param input - 写入子进程 stdin 的内容。
 * @returns 退出码为 0 时兑现，否则以含 stderr 的错误拒绝。
 */
export type CommandRunner = (program: string, args: readonly string[], input: string) => Promise<void>

/** 默认执行器：收集 stderr，让失败原因能到达状态页。 */
const runCommand: CommandRunner = (program, args, input) => new Promise<void>((resolve, reject) => {
  const child = spawn(program, [...args], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.once('error', (error) => { reject(error) })
  child.once('exit', (code) => {
    if (code === 0) { resolve(); return }
    const tail = stderr.trim()
    reject(new Error(`${program} ${args.join(' ')} 退出码 ${code}${tail === '' ? '' : `：${tail}`}`))
  })
  child.stdin.end(input)
})

/** ensureKafka 的选项。 */
export interface EnsureKafkaOptions {
  /** 期望的 broker 地址；默认 127.0.0.1:9092,127.0.0.1:9093,127.0.0.1:9094。 */
  brokers?: KafkaBrokers
  /** docker-compose.yml 路径；默认用包内 infra/kafka/docker-compose.yml。 */
  composeFile?: string
  /** 环境变量自定义 broker（A2A_BUS_BOOTSTRAP）；设为空数组跳过环境变量检测。 */
  envBootstrap?: string
  /** 是否跳过 Docker 检测（用户已知道没有 Docker）。 */
  skipDocker?: boolean
  /** 是否跳过 WSL 检测。 */
  skipWsl?: boolean
  /** 覆盖启动命令的执行器，供测试驱动而不真正拉起容器。 */
  runner?: CommandRunner
  /** 覆盖 Docker 可用性探测，供测试隔离宿主机的 Docker 状态。 */
  dockerAvailable?: () => Promise<boolean>
  /** 覆盖 WSL 可用性探测，供测试隔离宿主机平台。 */
  wslAvailable?: () => Promise<boolean>
  /** 覆盖 broker 可达性探测，供测试驱动就绪与等待分支而不依赖真实网络。 */
  probe?: BrokerProbe
  /** 启动命令执行后等待 broker 监听的时限，默认 30 秒；0 只探一次。 */
  startupTimeoutMs?: number
}

const DEFAULT_BROKERS: KafkaBrokers = ['127.0.0.1:9092', '127.0.0.1:9093', '127.0.0.1:9094']

/** compose 项目名；与 deploy/a2a 版本一致，保证两次启动落到同一套集群与数据卷。 */
const PROJECT_NAME = 'kafka'

/** 启动命令执行后等待 broker 监听的默认时限。 */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

const require = createRequire(import.meta.url)
const DEFAULT_COMPOSE = join(dirname(require.resolve('@reachforstar/dsh-a2a-host/package.json')), 'infra', 'kafka', 'docker-compose.yml')

/** 检测单个 host:port 是否可连（TCP 探测，500ms 超时）。 */
function isPortReachable(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { resolve(false) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

/**
 * 解析 `host:port`。
 * @param broker - 待解析的地址。
 * @returns 主机与端口；缺少分隔符、主机为空或端口不是正整数时为 undefined。
 */
function parseBroker(broker: string): { host: string; port: number } | undefined {
  // 取最后一个冒号：带方括号的 IPv6 字面量（如 [::1]:9092）也能切对。
  const separator = broker.lastIndexOf(':')
  if (separator <= 0) return undefined
  const port = Number(broker.slice(separator + 1))
  if (!Number.isInteger(port) || port <= 0) return undefined
  return { host: broker.slice(0, separator), port }
}

/**
 * 检测 Kafka 集群是否已运行：对每个 broker 做 TCP 探测，至少一个可达即认为已运行。
 * @param brokers - 待探测的 `host:port` 列表，默认本机三 broker。
 * @returns 任一 broker 可达时为 true。
 */
export async function isKafkaRunning(brokers: KafkaBrokers = DEFAULT_BROKERS): Promise<boolean> {
  const results = await Promise.all(brokers.map(async (broker) => {
    const parsed = parseBroker(broker)
    if (parsed === undefined) return false
    return isPortReachable(parsed.host, parsed.port)
  }))
  return results.some(Boolean)
}

/**
 * 检测本机 Docker 是否可用。
 * @returns `docker info` 退出码为 0 时为 true。
 */
export function isDockerAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', windowsHide: true })
    child.once('error', () => { resolve(false) })
    child.once('exit', (code) => { resolve(code === 0) })
  })
}

/**
 * 检测 WSL 是否可用。
 * @returns Windows 上 `wsl --list --quiet` 退出码为 0 时为 true，其他平台恒为 false。
 */
export function isWslAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const child = spawn('wsl', ['--list', '--quiet'], { stdio: 'ignore', windowsHide: true })
    child.once('error', () => { resolve(false) })
    child.once('exit', (code) => { resolve(code === 0) })
  })
}

/**
 * 在本机用 docker compose 启动 Kafka 集群。
 * compose 内容经 stdin 传入：打包后文件位于 app.asar 内，docker 子进程无法按路径读取。
 * @param composeFile - compose 文件路径，默认本包 `infra/kafka/docker-compose.yml`。
 * @param runner - 命令执行器，默认起真实 `docker` 进程。
 * @returns 启动命令成功结束时兑现，非零退出码则拒绝。
 */
export async function startKafkaViaDocker(
  composeFile: string = DEFAULT_COMPOSE,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const content = readFileSync(composeFile, 'utf8')
  await runner('docker', ['compose', '-p', PROJECT_NAME, '-f', '-', 'up', '-d'], content)
}

/**
 * 在 WSL 中用 docker compose 启动 Kafka 集群。
 * @param composeFile - compose 文件路径；内容同样经 stdin 传入，避免 WSL 侧解析 Windows 盘符路径。
 * @param runner - 命令执行器，默认起真实 `wsl` 进程。
 * @returns 启动命令成功结束时兑现，非零退出码则拒绝。
 */
export async function startKafkaViaWsl(
  composeFile: string = DEFAULT_COMPOSE,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const content = readFileSync(composeFile, 'utf8')
  await runner('wsl', ['-e', 'bash', '-lc', `docker compose -p ${PROJECT_NAME} -f - up -d`], content)
}

/** 把未知错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 等待 broker 可连。
 * @param brokers - 待探测的 broker 列表。
 * @param timeoutMs - 等待时限；0 表示只探一次。
 * @param probe - 可达性探测，默认走 TCP 端口探测。
 * @returns 时限内任一次探测可达时为 true。
 */
async function waitForBrokers(brokers: KafkaBrokers, timeoutMs: number, probe: BrokerProbe): Promise<boolean> {
  if (await probe(brokers)) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000))
    if (await probe(brokers)) return true
  }
  return false
}

/**
 * 按优先级确保 Kafka 就绪：环境变量自定义 → 已运行 → Docker 启动 → WSL 启动 → 禁用。
 * 不抛错；未就绪时返回 ready: false + reason + detail，调用方决定是否降级。
 * @param options - broker 列表、环境变量快照、compose 路径与命令执行器的覆盖值。
 * @returns 是否就绪，以及实际使用的 broker 列表与判定原因。
 */
export async function ensureKafka(options: EnsureKafkaOptions = {}): Promise<KafkaEnsureResult> {
  const brokers = options.brokers ?? DEFAULT_BROKERS
  const runner = options.runner ?? runCommand
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const dockerAvailable = options.dockerAvailable ?? isDockerAvailable
  const wslAvailable = options.wslAvailable ?? isWslAvailable
  const probe = options.probe ?? isKafkaRunning

  // 1. 环境变量自定义 broker
  const envBootstrap = options.envBootstrap ?? process.env.A2A_BUS_BOOTSTRAP
  if (envBootstrap !== undefined && envBootstrap.length > 0) {
    const envBrokers = envBootstrap.split(',').map(s => s.trim()).filter(Boolean)
    if (envBrokers.length > 0) {
      return { ready: true, brokers: envBrokers, reason: 'env-override' }
    }
  }

  // 2. 检测是否已运行
  if (await probe(brokers)) {
    return { ready: true, brokers, reason: 'already-running' }
  }

  const composeFile = options.composeFile ?? DEFAULT_COMPOSE
  // 最后一条启动失败原因；全部路径失败时交给状态页，而不是只留一个「不可用」。
  let failure: KafkaEnsureResult['failure'] = 'no-runtime'
  let detail: string | undefined

  // 3. 本机 Docker
  if (!options.skipDocker && await dockerAvailable()) {
    try {
      await startKafkaViaDocker(composeFile, runner)
      if (await waitForBrokers(brokers, startupTimeoutMs, probe)) {
        return { ready: true, brokers, reason: 'started-via-docker' }
      }
      failure = 'not-listening'
      detail = `docker compose 已执行，但 ${brokers.join(',')} 在 ${Math.ceil(startupTimeoutMs / 1000)} 秒内均未监听`
    } catch (error) {
      failure = 'start-failed'
      detail = messageOf(error)
    }
  }

  // 4. WSL
  if (!options.skipWsl && await wslAvailable()) {
    try {
      await startKafkaViaWsl(composeFile, runner)
      if (await waitForBrokers(brokers, startupTimeoutMs, probe)) {
        return { ready: true, brokers, reason: 'started-via-wsl' }
      }
      failure = 'not-listening'
      detail = `wsl docker compose 已执行，但 ${brokers.join(',')} 在 ${Math.ceil(startupTimeoutMs / 1000)} 秒内均未监听`
    } catch (error) {
      failure = 'start-failed'
      detail = messageOf(error)
    }
  }

  // 5. 都不行
  return {
    ready: false,
    brokers,
    reason: 'unavailable',
    failure,
    ...(detail === undefined ? {} : { detail }),
  }
}
