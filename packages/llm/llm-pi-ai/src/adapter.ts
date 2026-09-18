/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  Provider,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmDiscoveredModel,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { catalogFromListing } from './discovery.ts'
import type { EndpointCatalogSource } from './discovery.ts'
import { buildProvider } from './provider.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { createModels, getSupportedThinkingLevels } from './models.ts'
import { toStreamChunks } from './stream.ts'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
  /**
   * Routes whose endpoint catalog could not be read, by route. An operation
   * addressing one of them reports that reading's fault — an unreachable URL,
   * a rejected key — instead of a missing model, which names nothing the
   * deployment can repair.
   */
  endpointErrors: ReadonlyMap<string, LlmError>
}

/** What one endpoint reading produced: a served route, or why it could not be read. */
type EndpointReading =
  | { readonly ok: true; readonly profile: ResolvedPiAiProviderProfile; readonly provider: Provider }
  | { readonly ok: false; readonly error: LlmError }

/**
 * One configuration's state: the snapshot the configuration alone materializes,
 * one endpoint reading per route whose catalog has to come from its endpoint,
 * and the snapshot those readings add up to.
 */
interface PiAiGeneration {
  /** The profiles this generation was built from, used as its identity. */
  readonly profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Routes the configuration alone materialized. */
  readonly base: PiAiSnapshot
  /** One reading per endpoint-catalog route, in flight or settled. */
  readonly probes: Map<string, Promise<void>>
  /** The readings that landed, success and failure alike. */
  readonly readings: Map<string, EndpointReading>
  /** The snapshot including every landed reading; dropped when one lands. */
  merged?: PiAiSnapshot | undefined
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /**
   * Current validated profiles by provider route, called once per operation.
   * The adapter recognizes an unchanged configuration by this map's identity,
   * so a getter must return the same map while the configuration is unchanged
   * — the plugin memoizes its resolution for exactly that reason; a fresh map
   * per call would re-read every endpoint-served route on every operation.
   */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
  /**
   * Read one route's models from its own endpoint, for a route whose catalog
   * neither the configuration nor the installed catalog supplies. Omitted
   * means such a route cannot be served: its operations report that the
   * endpoint its catalog would come from was never read.
   */
  discoverEndpointCatalog?: (source: EndpointCatalogSource) => Promise<readonly LlmDiscoveredModel[]>
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * Report one failed endpoint reading as the coded failure an operation
 * surfaces. A failure the reading already coded — an unreachable endpoint, a
 * rejected credential, a timeout — passes through unchanged: it names what the
 * deployment has to repair, which a restatement here would bury.
 * @param provider - the route being read, named in the fallback message.
 * @param error - whatever the reading threw.
 * @returns the failure this route reports until the configuration changes.
 */
function endpointFailure(provider: string, error: unknown): LlmError {
  if (error instanceof LlmError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new LlmError(
    `llm-pi-ai: provider "${provider}" endpoint catalog could not be read: ${detail}`,
    'INVALID_CONFIG',
    { cause: error },
  )
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 *
 * A route whose models neither the configuration nor the installed catalog
 * supplies is read from its own endpoint before the snapshot is built, once per
 * configuration: the reading is what makes a gateway with no shipped catalog
 * routable at all, and caching it per generation keeps that cost off every
 * later request while a configuration change still refreshes it.
 */
export class PiAiAdapter extends LlmAdapter {
  private generation: PiAiGeneration | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The generation for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private forCurrentProfiles(): PiAiGeneration {
    const profiles = this.config.profiles()
    if (this.generation?.profiles === profiles) return this.generation
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) {
      if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
    }
    this.generation = {
      profiles,
      base: { profiles, models, endpointErrors: new Map() },
      probes: new Map(),
      readings: new Map(),
    }
    return this.generation
  }

  /**
   * The snapshot for one operation, with the route it addresses read from its
   * endpoint first. Only the addressed route is read: a deployment whose other
   * gateway is unreachable must not make every request wait for it.
   * @param provider - the route this operation names.
   * @returns the snapshot the operation captures before its first await.
   */
  private async snapshotFor(provider: string): Promise<PiAiSnapshot> {
    const generation = this.forCurrentProfiles()
    const profile = generation.profiles.get(provider)
    if (profile?.endpointCatalog === undefined) return generation.base
    await this.probe(generation, profile)
    return this.merged(generation)
  }

  /** Read one route's endpoint catalog once per generation, however many operations ask. */
  private probe(generation: PiAiGeneration, profile: ResolvedPiAiProviderProfile): Promise<void> {
    const inFlight = generation.probes.get(profile.provider)
    if (inFlight !== undefined) return inFlight
    const probe = this.readRoute(generation, profile)
    generation.probes.set(profile.provider, probe)
    return probe
  }

  /**
   * Perform one endpoint reading and record what it produced. Nothing it can
   * hit escapes as a rejection: an unreadable catalog is a per-route failure
   * the operations on that route report, not a failure of the adapter.
   */
  private async readRoute(generation: PiAiGeneration, profile: ResolvedPiAiProviderProfile): Promise<void> {
    const source = profile.endpointCatalog
    /* v8 ignore next -- the sole caller only reads a route that carries one. */
    if (source === undefined) return
    const discover = this.config.discoverEndpointCatalog
    try {
      if (discover === undefined) {
        throw new LlmError(
          `llm-pi-ai: provider "${profile.provider}" resolves its models from ${source.baseURL}, which this build`
          + ' has no way to read',
          'INVALID_CONFIG',
        )
      }
      const catalog = catalogFromListing(source, await discover(source))
      // Built from the protocol the reading used rather than the route's own
      // override, which a gateway the catalog ships a card for leaves unset:
      // the reading is what established the protocol here.
      const provider = buildProvider({
        provider: profile.provider,
        displayName: profile.displayName,
        api: source.api,
        ...source.request.baseURL === undefined ? {} : { baseURL: source.request.baseURL },
        models: catalog.models,
        namesCredential: profile.apiKeyEnv !== undefined,
      })
      const { catalogError: _unread, ...resolved } = profile
      generation.readings.set(profile.provider, {
        ok: true,
        provider,
        profile: {
          ...resolved,
          piProvider: provider,
          modelErrors: catalog.modelErrors,
          configuredMaxTokens: catalog.configuredMaxTokens,
        },
      })
    } catch (error) {
      generation.readings.set(profile.provider, { ok: false, error: endpointFailure(profile.provider, error) })
    } finally {
      generation.merged = undefined
    }
  }

  /**
   * The snapshot including every landed reading. Rebuilt from the base each
   * time a reading lands, so the collection an operation holds is immutable and
   * never gains a provider underneath it.
   * @param generation - the configuration whose readings to include; every
   *   caller reaches this after a reading of the route it addresses landed.
   * @returns the merged snapshot, rebuilt on the first call after a reading lands.
   */
  private merged(generation: PiAiGeneration): PiAiSnapshot {
    if (generation.merged !== undefined) return generation.merged
    const models: MutableModels = createModels(this.config.auth)
    const profiles = new Map(generation.profiles)
    const endpointErrors = new Map<string, LlmError>()
    for (const profile of generation.profiles.values()) {
      if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
    }
    for (const [provider, reading] of generation.readings) {
      if (!reading.ok) {
        endpointErrors.set(provider, reading.error)
        continue
      }
      models.setProvider(reading.provider)
      profiles.set(provider, reading.profile)
    }
    const merged: PiAiSnapshot = { profiles, models, endpointErrors }
    generation.merged = merged
    return merged
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    // The endpoint reading is checked first: a route it could not serve has no
    // model diagnostics of its own, and "this endpoint refused the key" is the
    // fault to report rather than "this route has no configured model".
    const unread = snapshot.endpointErrors.get(provider)
    if (unread !== undefined) throw unread
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.config.profiles().get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.config.profiles().get(provider)?.retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const snapshot = await this.snapshotFor(provider)
    this.profileOf(snapshot, provider)
    return snapshot.models.getModels(provider).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.modelInfo(await this.snapshotFor(provider), provider, model)
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
    }
  }

  override async prepareCall(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const snapshot = await this.snapshotFor(provider)
    return {
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot),
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamResolved(options)
  }

  /** Resolve the addressed route before streaming, so one request reads one snapshot. */
  private async * streamResolved(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamWithSnapshot(options, await this.snapshotFor(options.provider))
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const apiKey = await this.config.resolveApiKey(options.provider, profile)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext({ ...options, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade)
      const events = snapshot.models.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
