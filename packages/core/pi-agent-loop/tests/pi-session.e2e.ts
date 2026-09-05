/**
 * Real-API smoke for the Pi session opener used by `pi-agent-loop`. Proves the
 * integration can drive a live Pi turn through a user-configured
 * OpenAI-compatible gateway (`.env`: `AMAX_API_KEY`, `AMAX_MODEL`,
 * `AMAX_BASE_URL`). It
 * self-skips without those three variables, matching the repository's e2e
 * policy — no credential is ever hardcoded.
 *
 * @module dsh-pi-agent-loop/test/pi-session.e2e
 */

import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const apiKey = process.env.AMAX_API_KEY
const modelId = process.env.AMAX_MODEL
const baseUrl = process.env.AMAX_BASE_URL
const itLive = apiKey !== undefined && modelId !== undefined && baseUrl !== undefined ? it : it.skip

/** Record only assistant text deltas emitted while the turn streams. */
function collectText(session: AgentSession): { text: string[]; stop: () => void } {
  const text: string[] = []
  const stop = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      text.push(event.assistantMessageEvent.delta)
    }
  })
  return { text, stop }
}

describe('pi agent session (real)', () => {
  const homes: string[] = []
  afterEach(async () => {
    await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  itLive('runs a real pi turn that lists a marker file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-e2e-'))
    homes.push(cwd)
    await writeFile(join(cwd, 'marker-pi-e2e.txt'), 'pi e2e marker\n')
    // `itLive` above narrows selection, not these module-level strings.
    if (baseUrl === undefined || apiKey === undefined || modelId === undefined) {
      throw new Error('missing gateway config (AMAX_API_KEY/AMAX_MODEL/AMAX_BASE_URL)')
    }

    const modelRuntime = await ModelRuntime.create()
    // Register the gateway from .env as a one-shot OpenAI-compatible provider:
    // the key is a runtime credential, never committed.
    modelRuntime.registerProvider('amax', {
      baseUrl,
      apiKey,
      api: 'openai-completions',
      models: [
        {
          id: modelId,
          name: modelId,
          api: 'openai-completions',
          baseUrl,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8192,
        },
      ],
    })
    const model = modelRuntime.getModel('amax', modelId)
    expect(model).toBeDefined()
    if (model === undefined) throw new Error(`gateway model "${modelId}" did not register`)

    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(),
      modelRuntime,
      model,
      tools: ['read', 'bash'],
    })

    const { text, stop } = collectText(session)
    await session.prompt('Use bash `ls` to list the files in the current directory, then tell me the file names you see.')
    stop()

    // A failed turn (bad key, provider error) must name its cause instead of
    // leaving the caller with an empty transcript.
    if (session.state.errorMessage !== undefined) {
      throw new Error(`pi turn failed: ${session.state.errorMessage}`)
    }

    expect(text.join('')).toContain('marker-pi-e2e.txt')
    session.dispose()
  }, 180_000)
})
