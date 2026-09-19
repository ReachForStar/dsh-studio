import { readFileSync } from 'node:fs'
import type { A2ABusConfig } from './bus.ts'

/**
 * One agent endpoint, as the bridge's configuration file names it.
 *
 * The endpoint is an HTTP origin on loopback: the bridge binds its gateways to
 * `127.0.0.1`, and the port is what tells the three agents apart.
 */
export interface A2ABridgeAgent {
  /** JSON-RPC port the agent's gateway listens on. */
  port: number
  /** Working directory a task runs in when the caller names none. */
  defaultWorkspace: string
}

/** The agents one bridge deployment runs, by the names callers address them with. */
export interface A2ABridgeAgents {
  /** Pi-backed agent, whose skills cover development, maintenance, and analysis. */
  pi: A2ABridgeAgent
  /** Claude Code agent, whose skills cover review and coding. */
  'claude-code': A2ABridgeAgent
  /** OpenCode agent, whose skills cover review, coding, and analysis. */
  opencode: A2ABridgeAgent
}

/** Skill identifiers each agent accepts, read from the deployment's skill maps. */
export interface A2ABridgeSkills {
  /** Skills the Pi agent advertises. */
  pi: string[]
  /** Skills the Claude Code agent advertises. */
  'claude-code': string[]
  /** Skills the OpenCode agent advertises. */
  opencode: string[]
}

/**
 * The bridge deployment this harness dispatches into.
 *
 * This mirrors the bridge's own `config/config.json` so both sides read one
 * file: ports, workspace defaults, bus topics, and the skill maps that decide
 * which tools the far side runs with.
 */
export interface A2ABridgeConfig {
  /** Key every gateway expects in `X-Api-Key`; empty when the deployment is loopback-only. */
  apiKey: string
  /** Agent endpoints, by the name callers address them with. */
  agents: A2ABridgeAgents
  /** Skills each agent accepts, derived from the deployment's skill maps. */
  skills: A2ABridgeSkills
  /** Kafka topics and delivery limits the bus uses. */
  bus: A2ABusConfig
  /** Model the Pi gateway runs its sessions with. */
  piModel: string
  /** Model the OpenCode gateway runs its sessions with. */
  opencodeModel: string
  /** How long a gateway keeps an idle conversation before reclaiming it. */
  idleMs: number
  /** How long one bus task may run before it fails and moves to the dead-letter topic. */
  taskTimeoutMs: number
}

/** Where a bridge configuration is read from. */
export interface A2ABridgeConfigSource {
  /** Path to the bridge's `config.json`; defaults to `A2A_CONFIG`. */
  path?: string
  /** Environment to read overrides from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

/** Environment variables the bridge's own launcher honors, honored here too. */
const ENV = {
  /** Path of the configuration file, when it is not passed explicitly. */
  configPath: 'A2A_CONFIG',
  /** Gateway API key. */
  apiKey: 'A2A_API_KEY',
  /** Comma-separated broker list, replacing the configured one. */
  busBootstrap: 'A2A_BUS_BOOTSTRAP',
  /** Model override for the Pi gateway. */
  piModel: 'A2A_PI_MODEL',
  /** Model override for the OpenCode gateway. */
  opencodeModel: 'A2A_OC_MODEL',
} as const

/** Bus settings applied when the file leaves them out, matching the bridge's defaults. */
const BUS_DEFAULTS: A2ABusConfig = {
  bootstrapServers: ['127.0.0.1:9092'],
  taskTopic: 'a2a.task',
  eventTopic: 'a2a.event',
  dlqTopic: 'a2a.dlq',
  partitions: 6,
  maxAttempts: 3,
}

/** Port each agent listens on when the file leaves it out, matching the bridge's defaults. */
const AGENT_DEFAULTS: A2ABridgeAgents = {
  pi: { port: 9310, defaultWorkspace: '' },
  'claude-code': { port: 9320, defaultWorkspace: '' },
  opencode: { port: 9330, defaultWorkspace: '' },
}

/** Skill maps applied when the file leaves them out, matching the bridge's defaults. */
const SKILL_DEFAULTS = {
  pi: { 'code-dev': [], 'repo-maintenance': [], analysis: [] },
  'claude-code': { 'code-review': [], coding: [] },
  opencode: { 'code-review': '', analysis: '', coding: '' },
} as const

/**
 * Read the bridge configuration this harness dispatches into.
 *
 * A configured file that cannot be read or parsed fails here rather than at the
 * first dispatch, because a half-applied bridge configuration is undetectable
 * from the caller's side: it looks like an agent that is simply down.
 * @param source - configuration path and environment; defaults to `A2A_CONFIG`.
 * @returns the resolved deployment configuration.
 * @throws Error when no path is configured, or the configured file is unreadable or invalid.
 */
export function loadA2ABridgeConfig(source: A2ABridgeConfigSource = {}): A2ABridgeConfig {
  const env = source.env ?? process.env
  const path = source.path ?? env[ENV.configPath]
  if (path === undefined || path.length === 0) {
    throw new Error(`a2a bridge: no configuration path; pass one or set ${ENV.configPath}`)
  }
  const raw = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`a2a bridge: ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const file = asRecord(parsed, path)

  const agents = asRecord(file.agents ?? {}, `${path}: agents`)
  const bus = asRecord(file.bus ?? {}, `${path}: bus`)

  const busBootstrap = env[ENV.busBootstrap]
  const busConfig: A2ABusConfig = {
    bootstrapServers: busBootstrap === undefined || busBootstrap.length === 0
      ? asStringArray(bus.bootstrapServers, `${path}: bus.bootstrapServers`) ?? BUS_DEFAULTS.bootstrapServers
      : busBootstrap.split(',').map(item => item.trim()).filter(item => item.length > 0),
    taskTopic: asString(bus.taskTopic) ?? BUS_DEFAULTS.taskTopic,
    eventTopic: asString(bus.eventTopic) ?? BUS_DEFAULTS.eventTopic,
    dlqTopic: asString(bus.dlqTopic) ?? BUS_DEFAULTS.dlqTopic,
    partitions: asNumber(bus.partitions) ?? BUS_DEFAULTS.partitions,
    maxAttempts: asNumber(bus.maxAttempts) ?? BUS_DEFAULTS.maxAttempts,
  }

  return {
    apiKey: env[ENV.apiKey] ?? '',
    agents: {
      pi: agentOf(agents.pi, `${path}: agents.pi`, AGENT_DEFAULTS.pi),
      'claude-code': agentOf(agents['claude-code'], `${path}: agents["claude-code"]`, AGENT_DEFAULTS['claude-code']),
      opencode: agentOf(agents.opencode, `${path}: agents.opencode`, AGENT_DEFAULTS.opencode),
    },
    skills: {
      pi: skillIds(file.piSkillTools, `${path}: piSkillTools`, Object.keys(SKILL_DEFAULTS.pi)),
      'claude-code': skillIds(file.claudeSkillTools, `${path}: claudeSkillTools`, Object.keys(SKILL_DEFAULTS['claude-code'])),
      opencode: skillIds(file.opencodeSkillAgents, `${path}: opencodeSkillAgents`, Object.keys(SKILL_DEFAULTS.opencode)),
    },
    bus: busConfig,
    piModel: env[ENV.piModel] ?? asString(file.piModel) ?? '',
    opencodeModel: env[ENV.opencodeModel] ?? asString(file.opencodeModel) ?? '',
    idleMs: asNumber(file.idleMs) ?? 30 * 60 * 1000,
    taskTimeoutMs: asNumber(file.taskTimeoutMs) ?? 10 * 60 * 1000,
  }
}

/** Read one agent entry, falling back to its default port and workspace. */
function agentOf(value: unknown, at: string, fallback: A2ABridgeAgent): A2ABridgeAgent {
  if (value === undefined) return fallback
  const record = asRecord(value, at)
  return {
    port: asNumber(record.port) ?? fallback.port,
    defaultWorkspace: asString(record.defaultWorkspace) ?? fallback.defaultWorkspace,
  }
}

/** Read the skill ids one agent accepts, which are the keys of its skill map. */
function skillIds(value: unknown, at: string, fallback: string[]): string[] {
  if (value === undefined) return fallback
  return Object.keys(asRecord(value, at))
}

/** Narrow a parsed value to a record, naming the field that was not one. */
function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`a2a bridge: ${at} must be an object`)
  }
  return value as Record<string, unknown>
}

/** Read a string field, or `undefined` when it is absent or another type. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Read a numeric field, or `undefined` when it is absent or another type. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a string array field, or `undefined` when it is absent or another type. */
function asStringArray(value: unknown, at: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`a2a bridge: ${at} must be an array of strings`)
  }
  return value as string[]
}
