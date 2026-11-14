/**
 * Bridge for unmodified Claude Code command hooks on harness interception
 * extension points. It supports SessionStart, prompt/tool pre/post, Stop, and subagent
 * start/stop. It owns Claude payloads, environment, substitution, and decision
 * mapping; shared execution and parsing live in `dsh-hook-protocol`.
 * `updatedInput` is logged and warned but not honored. Bespoke behavior should
 * use typed native plugins on the same extension points. A per-Session project
 * config runs only under a digest trust approved through `/hooks`.
 * @module @deepseek-ai/dsh-hooks-claude-code
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hooks-claude-code': { kind: 'hooks-claude-code' } & ContextFormed
  }
}

import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  mergeHookOutputs,
  runHook,
  selectHookGroups,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
// Pulls in the declaration-merged subagent events and the identity pairing their
// start/end edges.
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { parseClaudeCodeConfig, type ClaudeCodeHookConfig } from './config.ts'
import { digestHookConfig, projectHookTrustSpec, type ProjectHookTrust } from './trust.ts'

export const name = 'hooks-claude-code'
// `shell` runs hooks and `agents` supplies turn numbers; the rest
// are read opportunistically via ctx.get so a deployment can omit them.
export const inject = ['shell', 'agents', 'workingDirectory']

/** Plugin config: where the CC hook config lives + substitution roots. */
export interface Config {
  /**
   * Path to a `hooks.json` or a settings file whose `hooks` key holds the config.
   * Process-level: read once at load, a relative path resolves against the process
   * launch cwd, so one config applies to the whole process. Project-local hooks
   * come from `projectHooksPath` under each Session working directory.
   */
  configPath: string
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's current directory (the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
  /**
   * Project-relative path checked for each Session working directory. Its
   * hooks run only while the file's exact content is trusted for that project;
   * editing the file suspends them until `/hooks trust` approves the new
   * content. Defaults to `.claude/settings.json`.
   */
  projectHooksPath?: string
}

export const Config: z<Config> = z.object({
  configPath: z.string().required(),
  pluginRoot: z.string(),
  projectDir: z.string(),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  projectHooksPath: z.string().default('.claude/settings.json'),
})

/** A stable per-handler id so an invoked/result pair correlates in the log. */
let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `claude-code:${point}:${++handlerCounter}`
}

/** The `{kind:'hooks-claude-code'}` producer source stamped on every context this bridge injects. */
const CONTEXT_SOURCE: MessageSource = { kind: 'hooks-claude-code' }

/** The summary cap bounds a persisted event field — a positive integer or the slice misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`hooks-claude-code: ${name} must be a positive integer`)
  }
}

export function apply(ctx: Context, config: Config): void {
  // Validate before config parsing so a bad value cannot be hidden by its early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  // Parse once at load. A read or parse failure logs and registers nothing.
  let parsed: ClaudeCodeHookConfig = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(config.configPath, 'utf8'))
    const result = parseClaudeCodeConfig(raw, {
      ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
      ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
    })
    parsed = result.config
    for (const s of result.skipped) {
      ctx.logger.warn(`hooks-claude-code: skipping unsupported "${s.type}" hook on ${s.event} (only command hooks run)`)
    }
  } catch (error: unknown) {
    ctx.logger.warn(`hooks-claude-code: could not load hook config "${config.configPath}": ${String(error)} — no hooks registered`)
    return
  }

  // Emit-shaped points run detached, so track their chains; disposal aborts
  // active hooks and drains continuations before resolving.
  const detached = createDetachedRuns()
  // Only the start edge guarantees registry access. Retain each local child
  // through its paired end so stop hooks keep the session workspace after the
  // handle unregisters the agent. Every retained entry relies on that paired
  // end; a producer that can omit it must provide another release edge.
  const subagentChildren = new Map<SubagentRunId, Agent>()
  ctx.effect(() => () => detached.drain(), 'hooks-claude-code: drain detached hook runs')

  const projectHooksPath = config.projectHooksPath ?? '.claude/settings.json'
  interface DiscoveredHooks {
    readonly digest: string
    readonly config: ClaudeCodeHookConfig
  }
  // Cache by absolute path and file stamp: a content edit changes the stamp and
  // forces a re-read, so a revoked or edited file cannot keep running stale groups.
  const discovered = new Map<string, { readonly stamp: string; readonly hooks: DiscoveredHooks | undefined }>()
  const warnedTrust = new Set<string>()
  let trustTable: KvTable<string, ProjectHookTrust> | undefined
  let trustOpening: Promise<KvTable<string, ProjectHookTrust> | undefined> | undefined

  /** Open the trust table on first use; absent storage leaves project hooks untrusted. */
  function trustTableOf(): Promise<KvTable<string, ProjectHookTrust> | undefined> {
    if (trustTable !== undefined) return Promise.resolve(trustTable)
    trustOpening ??= (async () => {
      const storageDomain = ctx.get('storageDomain')
      if (storageDomain === undefined) return undefined
      const domain = await storageDomain.open(projectHookTrustSpec)
      if (ctx.fiber.uid === null) {
        await domain.close()
        return undefined
      }
      ctx.effect(() => () => domain.close(), 'hooks-claude-code: project hook trust domain')
      trustTable = domain.table('projects')
      return trustTable
    })().finally(() => { trustOpening = undefined })
    return trustOpening
  }

  /** Read one project's hook configuration, re-reading only when the file changed. */
  function projectHooksOf(cwd: string): DiscoveredHooks | undefined {
    const path = join(cwd, projectHooksPath)
    let stamp: string
    try {
      const stat = statSync(path)
      stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`
    } catch {
      discovered.delete(path)
      return undefined
    }
    const cached = discovered.get(path)
    if (cached?.stamp === stamp) return cached.hooks
    let hooks: DiscoveredHooks | undefined
    try {
      const raw = readFileSync(path, 'utf8')
      const parsedProject = parseClaudeCodeConfig(JSON.parse(raw), {
        ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
        projectDir: cwd,
      })
      for (const skipped of parsedProject.skipped) {
        ctx.logger.warn(`hooks-claude-code: skipping unsupported "${skipped.type}" hook on ${skipped.event} in ${projectHooksPath} (only command hooks run)`)
      }
      hooks = { digest: digestHookConfig(raw), config: parsedProject.config }
    } catch (error: unknown) {
      ctx.logger.warn(`hooks-claude-code: could not parse project hooks "${path}": ${String(error)} — project hooks disabled`)
    }
    discovered.set(path, { stamp, hooks })
    return hooks
  }

  /**
   * The project groups that may run for this call. Only an exact trusted digest
   * enables them: an edited configuration suspends every project hook until the
   * new content is approved, and a project without a trust record runs none.
   */
  async function projectGroupsOf(point: string, agent: Agent | undefined): Promise<readonly MatcherGroup[]> {
    const cwd = agent?.session.header.cwd
    if (cwd === undefined) return []
    const hooks = projectHooksOf(cwd)
    if (hooks === undefined) return []
    const table = await trustTableOf()
    if (table?.get(cwd)?.digest === hooks.digest) return hooks.config[point] ?? []
    const key = `${cwd}\0${hooks.digest}`
    if (!warnedTrust.has(key)) {
      warnedTrust.add(key)
      ctx.logger.warn(`hooks-claude-code: project hooks in "${join(cwd, projectHooksPath)}" are not trusted for this content (digest ${hooks.digest.slice(0, 12)}); run /hooks trust to enable them`)
    }
    return []
  }

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'hooks',
      description: "Inspect, trust, or revoke this project's Claude Code hook configuration",
      handler: (invocation): Promise<CommandResult> => hooksCommand(invocation),
    })
  })

  /** `/hooks [status|trust|revoke]` over the calling Session's project directory. */
  async function hooksCommand(invocation: CommandInvocation): Promise<CommandResult> {
    const cwd = invocation.agent.session.header.cwd
    if (cwd === undefined) {
      return { kind: 'error', text: 'Hook trust needs a project directory; this Session records none.' }
    }
    const action = invocation.rawInput.trim()
    const hooks = projectHooksOf(cwd)
    const digest = hooks?.digest.slice(0, 12) ?? 'none'
    const table = await trustTableOf()
    if (action === '' || action === 'status') {
      if (hooks === undefined) return { kind: 'success', text: `No hook configuration at "${projectHooksPath}".` }
      return {
        kind: 'success',
        text: table?.get(cwd)?.digest === hooks.digest
          ? `Project hooks at "${projectHooksPath}" are trusted (digest ${digest}).`
          : `Project hooks at "${projectHooksPath}" are not trusted (digest ${digest}); run /hooks trust to enable them.`,
      }
    }
    if (action !== 'trust' && action !== 'revoke') {
      return { kind: 'error', text: 'Usage: /hooks [status|trust|revoke]' }
    }
    if (table === undefined) return { kind: 'error', text: 'Hook trust requires a mounted storage domain.' }
    if (action === 'trust') {
      if (hooks === undefined) {
        return { kind: 'error', text: `No hook configuration at "${join(cwd, projectHooksPath)}" to trust.` }
      }
      await table.put(cwd, { digest: hooks.digest, trustedAt: Date.now() })
      return { kind: 'success', text: `Trusted project hooks at "${projectHooksPath}" (digest ${digest}).` }
    }
    // The earlier guard leaves `revoke` as the only remaining action.
    const recorded = table.get(cwd) !== undefined
    if (recorded) await table.delete(cwd)
    return {
      kind: 'success',
      text: recorded
        ? `Revoked project hook trust for "${cwd}".`
        : `No project hook trust is recorded for "${cwd}".`,
    }
  }

  /**
   * Run every command hook configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` on stdin, and fold the results.
   * Writes a `hook/invoked`/`hook/result` pair per hook when `opts.turn` names
   * an open turn. Detached lifecycle points omit the pair. Returns the merged outcome (a neutral,
   * already-most-restrictive view) for the caller to map onto its extension point
   * decision. `matchQuery` is the event's matcher subject (tool name, session
   * source, …); `''` for events that ignore matchers.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: Record<string, unknown>,
    opts: { agent?: Agent; turn?: number; directory?: 'committed'; readonly signal: AbortSignal },
  ): Promise<MergedHookOutcome> {
    const groups = selectHookGroups([
      ...parsed[point] ?? [],
      ...await projectGroupsOf(point, opts.agent),
    ], matchQuery, 'claude-code')
    if (groups.length === 0) return mergeHookOutputs([])
    const outputs: HookOutput[] = []
    const workdir = opts.agent === undefined ? undefined
      : opts.directory === 'committed' ? ctx.workingDirectory.get(opts.agent.session)
        : await ctx.workingDirectory.ensure(opts.agent, opts.signal)
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise default it to the session
    // workspace (the same dir the hook runs in).
    const projectDir = config.projectDir ?? workdir
    const hookEnv = projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    for (const group of groups) {
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude-code', handlerId,
            matcher: group.matcher,
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload: { ...payload, cwd: workdir ?? process.cwd() },
          defaultTimeoutMs,
          ...hookEnv ? { env: hookEnv } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          trailingNewline: true,
          // Discard a `hookSpecificOutput` block whose `hookEventName` names a
          // different event than the one firing (the schemas key it by event).
          expectedEventName: point,
        }, () => performance.now())
        outputs.push(output)
        if (output.updatedInput !== undefined) {
          ctx.logger.warn(`hooks-claude-code: ${point} hook requested updatedInput, which is not yet honored (ignored)`)
        }
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`hooks-claude-code: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  // TODO(hook-continue-false): `merged.stop` is logged but needs a run-level halt mechanism.

  /** Build additional model context from hook output, or return undefined when empty. */
  function contextFrom(merged: MergedHookOutcome): UserMessage | undefined {
    if (merged.additionalContext.length === 0) return undefined
    const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
    return createUserMessage({ content, source: CONTEXT_SOURCE })
  }

  /** Prepend one context without flattening source fields or other downstream metadata. */
  function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
    return [ours, ...theirs ?? []]
  }

  ctx.on('agent/created', async ({ agent, source, signal }) => {
    const ownerSignal = signal === undefined ? detached.signal : AbortSignal.any([signal, detached.signal])
    const run = runPoint('SessionStart', source, sessionStartPayload(agent, source), { agent, signal: ownerSignal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context) agent.inject(context)
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`hooks-claude-code: SessionStart hook failed: ${String(error)}`)
      })
    detached.track(run)
    await run
  })

  // --- UserPromptSubmit → PreStepDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    if (messages.length === 0) return next()
    const content = messages.flatMap(message => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(agent, content), { agent, turn, signal })
    if (merged.decision === 'deny') {
      return { kind: 'reject' }
    }
    // Delegate so later listeners may still rewrite or reject, then prepend our
    // context only to a downstream enter decision.
    const downstream = await next()
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return {
      ...downstream,
      messages: [...downstream.messages, ours],
    }
  })

  // --- PreToolUse → PreToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(ctx, exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(exec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    return next()
  })

  // --- PermissionRequest → pre-approval deny only. Matcher subject is the tool name. ---
  ctx.on('tools/permission-request', async (exec, next) => {
    const turn = lastTurn(ctx, exec.agent)
    const merged = await runPoint('PermissionRequest', exec.name, preToolPayload(exec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    // This point cannot grant: allow/ask fall through to the approval seam so a
    // human-only request still reaches a person, and rules still apply.
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PermissionRequest hook' }
    return next()
  })

  // --- PostToolUse → PostToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(ctx, exec.agent)
    const merged = await runPoint('PostToolUse', exec.name, postToolPayload(exec, result), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContexts: [context] } : {} }
    }
    // Our hooks did not block. DELEGATE so a later listener can still block/replace,
    // then fold our context onto its decision (a downstream block carries it too).
    const downstream = await next()
    if (!context) return downstream
    if (downstream.kind === 'block') {
      return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(context, downstream.additionalContexts),
    }
  })

  // PreCompact and PostCompact observe the durable compaction markers. A
  // blocking PreCompact answer is logged but does not cancel an admitted
  // compaction; the hook point remains observation-only here.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/start' && event.type !== 'compaction/end') return
    const agent = ctx.get('agents')?.get(session.id)
    const point = event.type === 'compaction/start' ? 'PreCompact' : 'PostCompact'
    const payload = {
      ...base(agent, point),
      trigger: event.data.sourceCommandId === undefined ? 'auto' : 'manual',
      custom_instructions: '',
    }
    detached.track(runPoint(point, '', payload, { ...agent ? { agent, directory: 'committed' } : {}, signal: detached.signal })
      .then((merged) => {
        if (merged.decision === 'deny') {
          ctx.logger.warn(`hooks-claude-code: ${point} hook answered deny; compaction continues because this hook point is observation-only`)
        }
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: ${point} hook failed: ${String(error)}`) }))
  })

  // A blocking Stop hook steers at the stopping boundary, which makes the
  // machine observe pending input and run another step.
  // TODO(stop-loop-guard): cap consecutive forced continuations; hooks must self-limit meanwhile.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const merged = await runPoint('Stop', '', stopPayload(agent), { agent, turn, signal })
    if (merged.decision === 'deny') {
      // A blocking Stop hook forces continuation.
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }))
    }
  })

  // SubagentStart may inject child context; SubagentStop only observes. Both
  // use the child's directory and the generic agent-type matcher subject.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    detached.track(runPoint('SubagentStart', SUBAGENT_TYPE, subagentPayload('SubagentStart', info, child), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context && child) child.inject(context)
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SubagentStart hook failed: ${String(error)}`) }))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    // The end edge follows child disposal; committed Session state remains readable.
    detached.track(runPoint('SubagentStop', SUBAGENT_TYPE, subagentPayload('SubagentStop', info, child), { ...child ? { agent: child, directory: 'committed' } : {}, signal: detached.signal })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SubagentStop hook failed: ${String(error)}`) }))
  })
}

/**
 * The `agent_type` value the bridge reports for SubagentStart/Stop. The harness
 * subagent seam carries no per-kind label, so the bridge uses Claude Code's own
 * Task-tool default — a hooks.json with a default/`*`/empty `agent_type` matcher
 * fires; a config matching a specific kind (e.g. `code-reviewer`) does not.
 */
const SUBAGENT_TYPE = 'general-purpose'

// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. ---

/** The last open turn number in the agent's log, or 0 without an agent. */
function lastTurn(ctx: Context, agent: Agent | undefined): number {
  if (!agent) return 0
  return ctx.agents.turnBoundaryOf(agent.session).lastTurn
}

/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

function base(agent: Agent | undefined, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    // The persistence seam exposes no artifact path; the field stays empty
    // (a durable consumer gap recorded in this package's README).
    transcript_path: '',
    hook_event_name: event,
  }
}

function sessionStartPayload(agent: Agent, source: string): Record<string, unknown> {
  return { ...base(agent, 'SessionStart'), source }
}
function promptPayload(agent: Agent, content: ContentBlock[]): Record<string, unknown> {
  return { ...base(agent, 'UserPromptSubmit'), prompt: blocksToText(content) }
}
function preToolPayload(exec: ToolExecution): Record<string, unknown> {
  return { ...base(exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
}
function postToolPayload(exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  return { ...base(exec.agent, 'PostToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}
function stopPayload(agent: Agent): Record<string, unknown> {
  return { ...base(agent, 'Stop'), stop_hook_active: false }
}
/**
 * Build a SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the CC-default {@link SUBAGENT_TYPE}; `stop_hook_active`
 * is present on SubagentStop only (the loop-guard flag, always false).
 */
function subagentPayload(event: 'SubagentStart' | 'SubagentStop', info: { id: string }, child: Agent | undefined): Record<string, unknown> {
  return {
    ...base(child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}
