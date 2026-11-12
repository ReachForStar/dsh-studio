// @vitest-environment jsdom
/**
 * The fence layer over the real slot machinery: the plugin occupies the
 * `mermaid` language of `conversation.chat.markdown.fence`, draws a settled
 * fence through the injected renderer, keeps the owner's code block for a
 * streaming fence and for every other language, and leaves the slot with its
 * fiber. Mermaid itself is mocked, so no diagram engine runs in jsdom.
 */
import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import mermaid from 'mermaid'
import { apply, inject } from '../src/client/index.ts'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => ({ svg: `<svg data-id="${id}"></svg>` })),
  },
}))

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(mermaid.render).mockClear()
  vi.mocked(mermaid.initialize).mockClear()
})

const SID = 'mermaid-fence' as SessionId
const FENCE = 'conversation.chat.markdown.fence'

/** The owner's code block, as ChatView passes it to the fence slot. */
function codeBlock(code: string): ReactNode {
  return <pre data-testid="code-block">{code}</pre>
}

/** Boot the plugin on a real slot runtime with a retained Session. */
async function bench() {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.sessions.add({ id: SID })
  const session = runtime.sessions.retainFor(runtime.ctx, SID)
  const handle = await runtime.mount({ inject: [...inject], apply })
  await runtime.declare({ [FENCE]: { kind: 'hoc', scope: 'session' } })
  return { runtime, session, handle }
}

describe('Mermaid fence layer', () => {
  it('draws a settled mermaid fence through the plugin renderer', async () => {
    const { runtime, session } = await bench()
    const view = runtime.renderSlot(FENCE, { lang: 'mermaid', code: 'graph TD;A-->B', streaming: false }, {
      entryKey: 'mermaid',
      session,
      children: codeBlock('graph TD;A-->B'),
    } as never)
    await waitFor(() => { expect(view.container.querySelector('[data-mermaid-diagram] svg')).not.toBeNull() })
    expect(view.container.querySelector('[data-id]')?.getAttribute('data-id')).toMatch(/^mermaid-diagram-\d+$/u)
    expect(view.container.querySelector('[data-testid="code-block"]')).toBeNull()
    expect(vi.mocked(mermaid.render)).toHaveBeenCalledOnce()
    expect(vi.mocked(mermaid.initialize)).toHaveBeenCalledWith({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    })
  })

  it('keeps the code block for every other fence language', async () => {
    const { runtime, session } = await bench()
    const view = runtime.renderSlot(FENCE, { lang: 'js', code: 'const a = 1', streaming: false }, {
      entryKey: 'js',
      session,
      children: codeBlock('const a = 1'),
    } as never)
    expect(view.container.querySelector('[data-testid="code-block"]')?.textContent).toBe('const a = 1')
    expect(view.container.querySelector('[data-mermaid-diagram]')).toBeNull()
    expect(vi.mocked(mermaid.render)).not.toHaveBeenCalled()
  })

  it('keeps the code block while the mermaid fence streams', async () => {
    const { runtime, session } = await bench()
    const view = runtime.renderSlot(FENCE, { lang: 'mermaid', code: 'graph TD;A--', streaming: true }, {
      entryKey: 'mermaid',
      session,
      children: codeBlock('graph TD;A--'),
    } as never)
    expect(view.container.querySelector('[data-testid="code-block"]')?.textContent).toBe('graph TD;A--')
    expect(view.container.querySelector('[data-mermaid-diagram]')).toBeNull()
    expect(vi.mocked(mermaid.render)).not.toHaveBeenCalled()
  })

  it('leaves the fence slot with its plugin fiber', async () => {
    const { runtime, handle } = await bench()
    expect(runtime.slots.entries(FENCE).map(entry => entry.options.key)).toEqual(['mermaid'])
    await act(async () => { await handle.dispose() })
    expect(runtime.slots.entries(FENCE)).toHaveLength(0)
  })
})
