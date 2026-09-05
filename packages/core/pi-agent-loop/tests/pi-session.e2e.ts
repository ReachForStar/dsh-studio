/**
 * Real-API smoke for the Pi session opener used by `pi-agent-loop`. Proves the
 * integration can drive a live Pi turn (its own model + its own tools). It
 * self-skips without `DEEPSEEK_API_KEY`, matching the repository's e2e policy.
 *
 * @module dsh-pi-agent-loop/test/pi-session.e2e
 */

import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const apiKey = process.env.DEEPSEEK_API_KEY
const itLive = apiKey === undefined ? it.skip : it

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

    const modelRuntime = await ModelRuntime.create()
    const model = modelRuntime.getModel('deepseek', 'deepseek-v4-flash')
    expect(model).toBeDefined()
    if (model === undefined) throw new Error('deepseek-v4-flash model not found')

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
