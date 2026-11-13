// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { apply, BtwController, inject } from '../src/client/index.ts'
import { BtwDialog } from '../src/client/BtwDialog.tsx'
import type { BtwDialogInjected, BtwDialogProps } from '../src/client/BtwDialog.tsx'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { BtwState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'

const id = (value: string): SessionId => value as SessionId
const messages: Record<string, string> = en
const t: BtwDialogProps['t'] = (key: string) => messages[key] ?? key
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function dialog(sessionId: SessionId | null): {
  readonly dismiss: ReturnType<typeof vi.fn>
  readonly view: ReturnType<typeof render>
} {
  const dismiss = vi.fn()
  const state: BtwState = { sessionId }
  const useBtw: SnapshotSelectorHook<BtwState> = selector => selector(state)
  const view = render(<BtwDialog useBtw={useBtw} dismiss={dismiss} t={t} />)
  return { dismiss, view }
}

describe('BtwController', () => {
  it('opens one Session and clears it on close', () => {
    const controller = new BtwController()
    controller.open(id('s1'))
    expect(controller.store.getSnapshot().sessionId).toBe('s1')
    controller.close()
    expect(controller.store.getSnapshot().sessionId).toBeNull()
  })
})

describe('BtwDialog', () => {
  it('renders nothing while closed', () => {
    dialog(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks on submit and shows the answer', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ answer: 'because' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const { dismiss } = dialog(id('s1'))
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: en.placeholder })
    fireEvent.change(input, { target: { value: 'why?' } })
    fireEvent.click(screen.getByRole('button', { name: en.submit }))
    expect(screen.getByText(en.thinking)).toBeTruthy()
    await waitFor(() => { expect(screen.getByText('because')).toBeTruthy() })
    expect(fetch.mock.calls[0]?.[0]).toBe('api/btw.ask')
    fireEvent.click(screen.getAllByRole('button', { name: en.close })[0])
    expect(dismiss).toHaveBeenCalled()
  })

  it('asks on Enter and ignores Shift+Enter or an empty question', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ answer: 'ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    dialog(id('s1'))
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: en.placeholder })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.submit }).disabled).toBe(true)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'why?' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'a' })
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByText('ok')).toBeTruthy() })
  })

  it('reports a failed request and an empty answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))
    dialog(id('s1'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'why?' } })
    fireEvent.click(screen.getByRole('button', { name: en.submit }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.failed) })
    cleanup()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answer: 5 }), { status: 200 })))
    dialog(id('s1'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'why?' } })
    fireEvent.click(screen.getByRole('button', { name: en.submit }))
    await waitFor(() => { expect(screen.getByText(en.answer)).toBeTruthy() })
    expect(screen.getByText(en.failed)).toBeTruthy()
  })
})

describe('client apply', () => {
  it('registers the menu action and the overlay, and removes them with the fiber', async () => {
    const ctx = new Context()
    type MenuDefinition = {
      readonly observe: () => readonly unknown[]
      readonly resolve: (props: { sessionId: SessionId }) => { run: () => void }[]
    }
    const menus: MenuDefinition[] = []
    let overlay: { inject: () => BtwDialogInjected } | undefined
    const locale = { register: vi.fn(() => () => {}), bind: () => t }
    ctx.provide('locale', locale as never)
    ctx.provide('contextMenus', {
      register: (definition: MenuDefinition) => { menus.push(definition); return () => {} },
    } as never)
    ctx.provide('slots', {
      inject: (_name: string, mount: () => () => void) => { mount(); return () => {} },
      register: (definition: { inject: () => BtwDialogInjected }) => { overlay = definition; return () => {} },
    } as never)
    const fiber = await ctx.plugin({ inject, apply })
    expect(inject).toEqual(['slots', 'locale', 'contextMenus'])
    expect(ctx.btw).toBeInstanceOf(BtwController)
    const menu = menus[0]
    if (menu === undefined || overlay === undefined) throw new Error('client registrations missing')
    expect(menu.observe()).toEqual([locale])
    menu.resolve({ sessionId: id('s1') })[0]?.run()
    expect(ctx.btw.store.getSnapshot().sessionId).toBe('s1')
    overlay.inject().dismiss()
    expect(ctx.btw.store.getSnapshot().sessionId).toBeNull()
    await fiber.dispose()
  })
})
