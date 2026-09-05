/**
 * Real-API integration for the stage-3 event alignment: a PiLoop-backed agent
 * drives a live Pi turn through the AMAX gateway, and the translated turn/step/
 * message events land in the dsh session log. Self-skips without the env trio.
 *
 * @module dsh-pi-agent-loop/test/pi-loop.e2e
 */

import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { PiLoop } from '@deepseek-ai/dsh-pi-agent-loop'
import type { OpenedPiSession } from '@deepseek-ai/dsh-pi-agent-loop'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const apiKey = process.env.AMAX_API_KEY
const modelId = process.env.AMAX_MODEL
const baseUrl = process.env.AMAX_BASE_URL
const itLive = apiKey !== undefined && modelId !== undefined && baseUrl !== undefined ? it : it.skip

/** Open a real Pi session pointed at the AMAX gateway from `.env`. */
async function openAmaxSession(cwd: string): Promise<OpenedPiSession> {
  if (baseUrl === undefined || apiKey === undefined || modelId === undefined) {
    throw new Error('missing gateway config (AMAX_API_KEY/AMAX_MODEL/AMAX_BASE_URL)')
  }
  const modelRuntime = await ModelRuntime.create()
  modelRuntime.registerProvider('amax', {
    baseUrl,
    apiKey,
    api: 'openai-completions',
    models: [{
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }],
  })
  const model = modelRuntime.getModel('amax', modelId)
  if (model === undefined) throw new Error(`gateway model "${modelId}" did not register`)
  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    model,
    tools: ['read', 'bash'],
  })
  return { session: session as unknown as OpenedPiSession['session'], dispose: () => { session.dispose() } }
}

describe('PiLoop event alignment (real)', () => {
  const homes: string[] = []
  afterEach(async () => {
    await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  itLive('folds a live Pi turn into the dsh session log', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-loop-e2e-'))
    homes.push(cwd)
    await writeFile(join(cwd, 'marker-loop.txt'), 'loop\n')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(PiLoop, { openSession: ({ cwd }) => openAmaxSession(cwd) })

    const handle = await ctx.agents.create({
      sessionId: SessionId('pi-loop-e2e'),
      meta: { backend: 'pi', cwd },
    })

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Run bash ls and tell me the file names.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    const types = handle.agent.session.snapshotEvents().map(event => event.type)
    // The turn folded into the dsh log with its step and model message.
    expect(types).toContain('turn/start')
    expect(types).toContain('step/start')
    expect(types).toContain('user/message')
    expect(types).toContain('assistant/message')
    expect(types).toContain('step/end')
    expect(types).toContain('turn/end')

    await handle.dispose()
  }, 180_000)
})
