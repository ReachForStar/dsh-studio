/**
 * Kafka 基础设施检测与启动：端口探测 → Docker → WSL → 环境变量自定义 → 禁用。
 * @module
 */

import { createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

import { dirname, join } from 'node:path'

/** Kafka broker 地址列表。 */
export type KafkaBrokers = readonly string[]

/** ensureKafka 的结果。 */
export interface KafkaEnsureResult {
  /** Kafka 是否已就绪（检测到运行或成功启动）。 */
  ready: boolean
  /** 就绪时实际可用的 broker 地址列表。 */
  brokers: KafkaBrokers
  /** 未就绪时的原因，供前端展示。 */
  reason?: 'already-running' | 'started-via-docker' | 'started-via-wsl' | 'env-override' | 'unavailable'
}

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
}

const DEFAULT_BROKERS: KafkaBrokers = ['127.0.0.1:9092', '127.0.0.1:9093', '127.0.0.1:9094']

const require = createRequire(import.meta.url)
const DEFAULT_COMPOSE = join(dirname(require.resolve('@reachforstar/dsh-a2a-host/package.json')), 'infra', 'kafka', 'docker-compose.yml')

/** 检测单个 host:port 是否可连（TCP 探测，500ms 超时）。 */
function isPortReachable(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const socket = createConnection({ host, port, timeout: timeoutMs })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

/** 检测 Kafka 集群是否已运行：对每个 broker 做 TCP 探测，至少一个可达即认为已运行。 */
export async function isKafkaRunning(brokers: KafkaBrokers = DEFAULT_BROKERS): Promise<boolean> {
  const results = await Promise.all(brokers.map(async (b) => {
    const parts = b.split(':')
    const host = parts[0]
    const port = Number(parts[1])
    if (host === undefined || Number.isNaN(port)) return false
    return isPortReachable(host, port)
  }))
  return results.some(Boolean)
}

/** 检测本机 Docker 是否可用（docker info 成功即认为可用）。 */
export function isDockerAvailable(): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const child = spawn('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', windowsHide: true })
    child.once('error', () => resolve(false))
    child.once('exit', code => resolve(code === 0))
  })
}

/** 检测 WSL 是否可用（wsl --list 成功即认为可用）。 */
export function isWslAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise<boolean>(resolve => {
    const child = spawn('wsl', ['--list', '--quiet'], { stdio: 'ignore', windowsHide: true })
    child.once('error', () => resolve(false))
    child.once('exit', code => resolve(code === 0))
  })
}

/** 在本机用 docker compose 启动 Kafka 集群。 */
export function startKafkaViaDocker(composeFile: string = DEFAULT_COMPOSE): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', composeFile, 'up', '-d'], { stdio: 'pipe', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`docker compose up 退出码 ${code}`)))
  })
}

/** 在 WSL 中用 docker compose 启动 Kafka 集群（compose 路径转 /mnt 形式）。 */
export function startKafkaViaWsl(composeFile: string = DEFAULT_COMPOSE): Promise<void> {
  const wslPath = composeFile.replace(/^([A-Z]):\\/i, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/')
  return new Promise<void>((resolve, reject) => {
    const child = spawn('wsl', ['-e', 'bash', '-lc', `docker compose -f ${wslPath} up -d`], { stdio: 'pipe', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`wsl docker compose up 退出码 ${code}`)))
  })
}

/**
 * 按优先级确保 Kafka 就绪：环境变量自定义 → 已运行 → Docker 启动 → WSL 启动 → 禁用。
 * 不抛错；未就绪时返回 ready: false + reason，调用方决定是否降级。
 */
export async function ensureKafka(options: EnsureKafkaOptions = {}): Promise<KafkaEnsureResult> {
  const brokers = options.brokers ?? DEFAULT_BROKERS

  // 1. 环境变量自定义 broker
  const envBootstrap = options.envBootstrap ?? process.env.A2A_BUS_BOOTSTRAP
  if (envBootstrap !== undefined && envBootstrap.length > 0) {
    const envBrokers = envBootstrap.split(',').map(s => s.trim()).filter(Boolean)
    if (envBrokers.length > 0) {
      return { ready: true, brokers: envBrokers, reason: 'env-override' }
    }
  }

  // 2. 检测是否已运行
  if (await isKafkaRunning(brokers)) {
    return { ready: true, brokers, reason: 'already-running' }
  }

  const composeFile = options.composeFile ?? DEFAULT_COMPOSE

  // 3. 本机 Docker
  if (!options.skipDocker && await isDockerAvailable()) {
    try {
      await startKafkaViaDocker(composeFile)
      // 等待 Kafka 就绪（最多 30s）
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000))
        if (await isKafkaRunning(brokers)) {
          return { ready: true, brokers, reason: 'started-via-docker' }
        }
      }
    } catch { /* Docker 启动失败，继续尝试 WSL */ }
  }

  // 4. WSL
  if (!options.skipWsl && await isWslAvailable()) {
    try {
      await startKafkaViaWsl(composeFile)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000))
        if (await isKafkaRunning(brokers)) {
          return { ready: true, brokers, reason: 'started-via-wsl' }
        }
      }
    } catch { /* WSL 启动失败，继续降级 */ }
  }

  // 5. 都不行
  return { ready: false, brokers, reason: 'unavailable' }
}