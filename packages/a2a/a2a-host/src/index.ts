import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createA2AServer, TaskStore } from '@reachforstar/dsh-a2a'
import type { A2AServer, AgentCard, AgentSkill } from '@reachforstar/dsh-a2a'
import { buildAgentCard, DEFAULT_SKILL } from './card.ts'
import { DshA2AExecutor } from './executor.ts'

export { buildAgentCard, DEFAULT_SKILL } from './card.ts'
export type { CardConfig } from './card.ts'
export { assistantText, DshA2AExecutor, streamText } from './executor.ts'
export type { DshA2AExecutorOptions } from './executor.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    a2aHost: A2AHostService
  }
}

/** 模块级插件名与依赖：`apply` 直接构造服务，注入必须挂在插件本身。 */
export const name = 'a2a-host'
export const inject = ['sessionController']

/** One advertised skill. */
const skillSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  description: z.string().required(),
  tags: z.array(z.string()).default([]),
  examples: z.array(z.string()).default([]),
  inputModes: z.array(z.string()).default([]),
  outputModes: z.array(z.string()).default([]),
})

/** Plugin configuration. */
export interface Config {
  /** Interface to bind; loopback keeps the endpoint off the network. */
  host?: string
  /** TCP port to bind; 0 binds a free port. */
  port?: number
  /** Value calls must carry in `X-Api-Key`; empty serves unauthenticated. */
  apiKey?: string
  /** Endpoint peers are told to call, when it differs from host and port. */
  url?: string
  /** Working directory sessions start in; the host default when absent. */
  cwd?: string
  /** Agent preset sessions are created with; the deployment default when absent. */
  agentPreset?: string
  /** How long one turn may run before its task fails. */
  turnTimeoutMs?: number
  /** Card identity and advertised skills. */
  card?: {
    name?: string
    description?: string
    version?: string
    documentationUrl?: string
    skills?: AgentSkill[]
  }
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.natural().default(9310),
  apiKey: z.string().default(''),
  url: z.string(),
  cwd: z.string(),
  agentPreset: z.string(),
  turnTimeoutMs: z.natural().default(30 * 60 * 1000),
  card: z.object({
    name: z.string().default('dsh-studio'),
    description: z.string().default('DeepSeek Harness agent sessions'),
    version: z.string().default('0.1.0'),
    documentationUrl: z.string().default(''),
    skills: z.array(skillSchema).default([DEFAULT_SKILL]),
  }).default({
    name: 'dsh-studio',
    description: 'DeepSeek Harness agent sessions',
    version: '0.1.0',
    documentationUrl: '',
    skills: [DEFAULT_SKILL],
  }),
})

/**
 * The A2A endpoint this deployment serves.
 *
 * Binding happens in {@link A2AHostService.init}: a port that cannot be taken
 * fails the plugin's fiber at load, which is where a deployment learns that its
 * advertised endpoint is not the one it is serving.
 */
export class A2AHostService extends Service {
  static inject = ['sessionController']

  /** The card peers read, rewritten once the bound port is known. */
  readonly card: AgentCard

  /** The task table this endpoint serves. */
  readonly store: TaskStore = new TaskStore()

  /**
   * Resolves once the listener is bound, and rejects when it cannot bind.
   *
   * Cordis runs a nested plugin's `init` outside the outer fiber's readiness,
   * so a deployment that must know its endpoint before serving waits here.
   */
  readonly ready: Promise<void>

  private settleReady!: () => void
  private failReady!: (error: unknown) => void
  private server: A2AServer | undefined

  /**
   * @param ctx - the owning host context.
   * @param config - endpoint, authentication, session, and card settings.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'a2aHost')
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = resolve
      this.failReady = reject
    })
    // A failed bind is reported to the awaiter, never as an unhandled rejection.
    this.ready.catch(() => {})
    const card = config.card ?? {}
    this.card = buildAgentCard({
      name: card.name ?? 'dsh-studio',
      description: card.description ?? 'DeepSeek Harness agent sessions',
      version: card.version ?? '0.1.0',
      ...card.documentationUrl === undefined || card.documentationUrl.length === 0
        ? {} : { documentationUrl: card.documentationUrl },
      url: config.url ?? `http://${config.host ?? '127.0.0.1'}:${String(config.port ?? 9310)}/`,
      skills: card.skills ?? [DEFAULT_SKILL],
      authenticated: (config.apiKey ?? '').length > 0,
    })
  }

  /** The endpoint peers call, as this deployment advertises it. */
  get url(): string {
    return this.card.supportedInterfaces[0]?.url ?? ''
  }

  /**
   * Bind the listener and own its lifetime.
   *
   * An OS-assigned port (`port: 0`) is only known after binding, so the card's
   * interface URL is rewritten then; everything else in the card is static.
   * @returns a promise resolved once the listener is bound.
   */
  async [Service.init](): Promise<void> {
    await this.start()
  }

  /**
   * Create the executor and bind the listener.
   *
   * Called by {@link Service.init} when this class is mounted as a plugin and
   * by {@link apply} when the module is mounted; both paths must bind before
   * they resolve, so a deployment learns at boot that its advertised endpoint
   * is the one it serves.
   * @returns a promise resolved once the listener is bound.
   */
  async start(): Promise<void> {
    const executor = new DshA2AExecutor({
      sessions: this.ctx.sessionController,
      ...this.config.cwd === undefined ? {} : { cwd: this.config.cwd },
      ...this.config.agentPreset === undefined ? {} : { agentPreset: this.config.agentPreset },
      ...this.config.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: this.config.turnTimeoutMs },
      onError: (message, error) => {
        this.ctx.logger.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`)
      },
    })
    const server = createA2AServer({
      card: this.card,
      executor,
      store: this.store,
      apiKey: this.config.apiKey ?? '',
      port: this.config.port ?? 9310,
      host: this.config.host ?? '127.0.0.1',
      onError: (message, error) => {
        this.ctx.logger.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`)
      },
    })
    this.server = server
    try {
      await server.ready
    } catch (error) {
      this.failReady(error)
      throw error
    }
    if (this.config.url === undefined) {
      const address = server.server.address()
      if (typeof address === 'object' && address !== null) {
        const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address
        const interface0 = this.card.supportedInterfaces[0]
        if (interface0 !== undefined) interface0.url = `http://${host}:${String(address.port)}/`
      }
    }
    this.ctx.effect(() => async () => {
      await server.close()
      this.server = undefined
    }, 'a2aHost.listen')
    this.settleReady()
  }

  /** Whether the listener is currently bound. */
  get listening(): boolean {
    return this.server !== undefined
  }

  /** The bound TCP port, which differs from the configured one when it was 0. */
  get port(): number | undefined {
    const address = this.server?.server.address()
    return typeof address === 'object' && address !== null ? address.port : undefined
  }
}

/**
 * Register the A2A host and wait for its listener.
 *
 * The service is constructed here rather than mounted through `ctx.plugin`:
 * Cordis runs a nested plugin's `init` outside the enclosing fiber, so a
 * module-level plugin that returned immediately would finish booting before its
 * endpoint existed — and would report neither the bound port nor a failed bind.
 * @param ctx - the owning host context.
 * @param config - endpoint, session, and card settings.
 * @returns a promise resolved once the listener is bound.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await new A2AHostService(ctx, config).start()
}
