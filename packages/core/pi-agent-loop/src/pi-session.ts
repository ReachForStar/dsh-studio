/**
 * Thin wrapper around the Pi coding-agent SDK so the loop's session creation
 * stays injectable. Tests replace this with a stub; the real integration calls
 * Pi's own services wirelessly plus any configured OpenAI-compatible gateways.
 *
 * @module dsh-pi-agent-loop/pi-session
 */

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { PiAgentSessionLike } from './agent.ts'

/** One gateway model the Pi runtime should advertise. */
export interface PiProviderModelConfig {
  readonly id: string
  readonly name: string
  readonly reasoning?: boolean
  readonly contextWindow: number
  readonly maxTokens: number
}

/** One OpenAI-compatible gateway registered into Pi's ModelRuntime. */
export interface PiProviderConfig {
  readonly id: string
  readonly baseUrl: string
  readonly apiKeyEnv: string
  readonly api?: 'openai-completions'
  readonly models: readonly PiProviderModelConfig[]
}

/** Module-shared Pi ModelRuntime: created once and reused across sessions. */
let sharedModelRuntime: Promise<ModelRuntime> | undefined

/** Return the process-shared Pi ModelRuntime, creating it on first use. */
function ensureModelRuntime(): Promise<ModelRuntime> {
  sharedModelRuntime ??= ModelRuntime.create()
  return sharedModelRuntime
}

/** Inputs for opening one Pi AgentSession tied to a dsh session cwd. */
export interface OpenPiSessionOptions {
  readonly cwd: string
  /** Optional dsh-routed provider; selects the Pi model when both are present. */
  readonly provider?: string
  /** Optional dsh-routed model id; selects the Pi model when both are present. */
  readonly modelId?: string
  /** Gateways registered into the Pi runtime before model selection. */
  readonly providers?: readonly PiProviderConfig[]
  /** Reuse one shared Pi ModelRuntime across sessions (avoids re-creation). */
  readonly modelRuntime?: ModelRuntime
}

/** One opened Pi AgentSession plus its disposal. */
export interface OpenedPiSession {
  readonly session: PiAgentSessionLike
  dispose(): void
}

/**
 * Open a Pi AgentSession backed by Pi's own services and an in-memory session
 * manager. Configured gateways are registered first; a missing `apiKeyEnv`
 * credential fails loud rather than silently skipping the route.
 * @param options - target cwd, optional model route, and gateway providers.
 * @returns the live session surface and its synchronous disposer.
 */
export async function openPiSession(options: OpenPiSessionOptions): Promise<OpenedPiSession> {
  const modelRuntime = options.modelRuntime ?? await ensureModelRuntime()
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    modelRuntime,
  })
  for (const provider of options.providers ?? []) {
    const apiKey = process.env[provider.apiKeyEnv]
    if (apiKey === undefined) {
      throw new Error(`pi provider "${provider.id}" requires the credential ${provider.apiKeyEnv} to be set`)
    }
    services.modelRuntime.registerProvider(provider.id, {
      baseUrl: provider.baseUrl,
      apiKey,
      api: provider.api ?? 'openai-completions',
      models: provider.models.map(model => ({
        id: model.id,
        name: model.name,
        api: provider.api ?? 'openai-completions',
        baseUrl: provider.baseUrl,
        reasoning: model.reasoning ?? false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    })
  }
  const sessionManager = SessionManager.inMemory(options.cwd)
  const model = options.provider !== undefined && options.modelId !== undefined
    ? services.modelRuntime.getModel(options.provider, options.modelId)
    : undefined
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...model === undefined ? {} : { model },
  })
  return { session: session as unknown as PiAgentSessionLike, dispose: () => { session.dispose() } }
}
