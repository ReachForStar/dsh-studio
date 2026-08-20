/**
 * Minimal Pi coding agent 0.84 RPC protocol adapter. Pi RPC mode speaks a
 * line-delimited JSON protocol over stdio: commands are JSON objects with a
 * `type` field and an optional `id` for correlation, responses are
 * `{ id, type: "response", command, success, data | error }` objects, and the
 * session streams typed events (notably `agent_settled` when the agent turn
 * ends). This module owns framing, command correlation, the unattended
 * extension-UI answers, and terminal-answer retrieval; the process lifecycle
 * lives in `run.ts`.
 *
 * @module @deepseek-ai/dsh-subagent-pi/wire
 */

import type { Readable, Writable } from 'node:stream'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'

type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`subagent-pi: Pi returned invalid ${label}`)
  }
  return value as JsonObject
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`subagent-pi: Pi request aborted: ${String(signal.reason)}`)
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The orphaned operation is observed without handling; its settlement is
    // not guaranteed within this call's lifetime.
    /* v8 ignore next -- pending settlement is caller-dependent */
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Extension-UI dialog methods that await a client response. */
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor'])

/**
 * One Pi RPC connection and its single session turn.
 *
 * The class deliberately exposes no generic command surface. Supporting
 * another Pi command must first become part of the provider contract.
 */
export class PiRpcWire {
  private readonly input: Readable
  private readonly output: Writable
  private readonly fatal = Promise.withResolvers<never>()
  private readonly settled = Promise.withResolvers<void>()
  private readonly pending = new Map<string, {
    readonly resolve: (response: JsonObject) => void
    readonly reject: (error: Error) => void
  }>()
  private buffer = ''
  private settledObserved = false
  private closed = false
  private nextId = 0

  constructor(input: Readable, output: Writable) {
    this.input = input
    this.output = output
    // Fatal protocol state can arrive after the current guarded operation has
    // already settled. Keep the shared rejection observed without inserting
    // another promise-adoption hop into active races.
    void this.fatal.promise.catch(() => {})
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    // Pipe errors can race protocol closure and process teardown. Retain both
    // error listeners for the lifetime of their per-run streams so no late
    // EPIPE or read failure becomes an unhandled EventEmitter error.
    output.on('error', this.onOutputError)
  }

  /** Start reading Pi frames. */
  start(): void {
    this.input.on('data', this.onData)
  }

  /**
   * Prove the RPC server is ready by resolving one `get_state` command.
   * @param signal - unpublished-start cancellation.
   */
  async ready(signal: AbortSignal): Promise<void> {
    const response = await this.guarded(this.request('get_state', {}, signal), signal)
    if (response.sessionId === undefined) {
      throw new Error('subagent-pi: Pi get_state response lacks a session id')
    }
  }

  /**
   * Submit the one text-only task. Resolves once Pi acknowledges preflight.
   * @param text - already validated task text.
   * @param signal - unpublished-start cancellation.
   */
  async prompt(text: string, signal: AbortSignal): Promise<void> {
    await this.guarded(this.request('prompt', { message: text }, signal), signal)
  }

  /**
   * Wait for the current agent turn to settle (`agent_settled` event).
   * @param signal - local cancellation for the published run.
   */
  async waitSettled(signal: AbortSignal): Promise<void> {
    if (this.settledObserved) return
    await this.guarded(this.settled.promise, signal)
  }

  /**
   * Read the final answer from the settled session: the last non-empty
   * assistant text, or undefined when Pi ended without one.
   * @param signal - local cancellation for the published run.
   * @returns the final assistant text, if any.
   */
  async lastAssistantText(signal: AbortSignal): Promise<string | undefined> {
    const response = await this.guarded(this.request('get_last_assistant_text', {}, signal), signal)
    const text = response.text
    if (text === undefined) return undefined
    if (typeof text !== 'string') {
      throw new Error('subagent-pi: Pi get_last_assistant_text returned invalid text')
    }
    return text
  }

  /**
   * The terminal result of the one turn: the exact final assistant text when
   * Pi settled with an answer, else an error (Pi settled without one).
   * @param text - the already validated task text.
   * @param signal - local cancellation for the published run.
   * @returns the shared subagent result, or a rejection mapped to `error` by
   * the run settlement when Pi settled without an answer.
   */
  async runTurn(text: string, signal: AbortSignal): Promise<SubagentResult> {
    await this.prompt(text, signal)
    await this.waitSettled(signal)
    const answer = await this.lastAssistantText(signal)
    if (answer === undefined || answer.trim().length === 0) {
      throw new Error('subagent-pi: Pi settled without a final answer')
    }
    return { output: [{ type: 'text', text: answer }], stopReason: 'completed' }
  }

  /**
   * Best-effort remote cancellation. Local settlement and process teardown
   * remain authoritative when the child no longer accepts protocol commands.
   */
  abort(): void {
    if (this.closed) return
    void this.request('abort', {}, new AbortController().signal).catch(() => {})
  }

  /**
   * Output snapshot for cancellation and failure settlement. Pi's protocol
   * offers no committed partial-answer projection, so the snapshot is empty.
   * @returns no content blocks.
   */
  collectOutput(): ContentBlock[] {
    return []
  }

  /** Detach stream listeners and reject outstanding commands. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.onData)
    this.input.off('end', this.onInputEnd)
    const error = new Error('subagent-pi: Pi RPC connection closed')
    for (const entry of this.pending.values()) {
      entry.reject(error)
    }
    this.pending.clear()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    const withFatal = Promise.race([this.fatal.promise, pending])
    return raceAbort(withFatal, signal)
  }

  private request(
    type: string,
    payload: JsonObject,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    const id = `${this.nextId++}`
    return new Promise<JsonObject>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('subagent-pi: Pi RPC connection is closed'))
        return
      }
      // Every settlement path removes the abort listener exactly once.
      let settled = false
      const settle = (finish: () => void): void => {
        if (settled) return
        settled = true
        finish()
      }
      const onAbort = (): void => {
        settle(() => {
          this.pending.delete(id)
          reject(abortError(signal))
        })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const entry = {
        resolve: (response: JsonObject): void => {
          settle(() => {
            signal.removeEventListener('abort', onAbort)
            resolve(response)
          })
        },
        reject: (error: Error): void => {
          settle(() => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          })
        },
      }
      this.pending.set(id, entry)
      let command: string
      try {
        command = JSON.stringify({ type, id, ...payload })
      } catch (error: unknown) {
        // The public command surface builds only plain stringifiable payloads;
        // a stringify failure is unreachable through the typed API.
        /* v8 ignore start -- defensive */
        settle(() => {
          signal.removeEventListener('abort', onAbort)
          this.pending.delete(id)
          reject(thrown(error))
        })
        return
        /* v8 ignore stop */
      }
      this.output.write(`${command}\n`, (error) => {
        if (error !== null && error !== undefined) {
          settle(() => {
            signal.removeEventListener('abort', onAbort)
            this.pending.delete(id)
            reject(error)
          })
        }
      })
    })
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    this.fail(new Error('subagent-pi: Pi protocol stream closed'))
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('utf8')
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) {
        this.handleLine(line)
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    try {
      this.handleFrame(line)
    } catch (error: unknown) {
      // A malformed frame of any shape fails the connection instead of
      // escaping as an uncaught stream-data exception.
      this.fail(thrown(error))
    }
  }

  private handleFrame(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      throw new Error('subagent-pi: Pi emitted an unparseable protocol line')
    }
    const frame = object(message, 'protocol frame')
    const type = frame.type
    if (type === 'response') {
      this.handleResponse(frame)
      return
    }
    if (type === 'extension_ui_request') {
      this.handleExtensionUiRequest(frame)
      return
    }
    if (type === 'agent_settled') {
      this.settledObserved = true
      this.settled.resolve()
      return
    }
    if (type === 'extension_error') {
      const messageText = typeof frame.error === 'string'
        ? frame.error
        : JSON.stringify(frame.error)
      throw new Error(`subagent-pi: Pi extension failed: ${messageText}`)
    }
  }

  private handleResponse(frame: JsonObject): void {
    const id = frame.id
    if (typeof id !== 'string') {
      this.fail(new Error('subagent-pi: Pi response lacks a command id'))
      return
    }
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    if (frame.success === true) {
      const data = frame.data
      entry.resolve(data === undefined ? {} : object(data, 'response data'))
    } else {
      const raw = frame.error
      const detail = typeof raw === 'string' && raw.length > 0
        ? raw
        : raw === undefined ? 'unknown error' : JSON.stringify(raw)
      entry.reject(new Error(
        `subagent-pi: Pi command ${JSON.stringify(frame.command)} failed: ${detail}`,
      ))
    }
  }

  private handleExtensionUiRequest(frame: JsonObject): void {
    const method = frame.method
    if (typeof method !== 'string' || !DIALOG_METHODS.has(method)) return
    const id = frame.id
    if (typeof id !== 'string') return
    this.output.write(`${JSON.stringify({ type: 'extension_ui_response', id, cancelled: true })}\n`)
  }
}
