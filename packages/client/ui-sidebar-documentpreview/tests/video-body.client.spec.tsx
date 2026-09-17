// @vitest-environment jsdom
/** Video Blob ownership, media types, player attributes, and failure states. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { VideoBody, videoMediaType, type VideoBodyProps } from '../src/client/video/VideoBody.tsx'
import { en } from '../src/client/video/locales.ts'

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
let createDescriptor: PropertyDescriptor | undefined
let revokeDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()
const revoke = vi.fn<(url: string) => void>()

beforeEach(() => {
  createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  create.mockReset().mockImplementation(() => `blob:https://preview.invalid/${create.mock.calls.length}`)
  revoke.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
})

afterEach(() => {
  try { cleanup() } finally {
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
  }
})

function props(path = 'clip.mp4', content: VideoBodyProps['content'] = { kind: 'bytes', data: new Uint8Array([1, 2, 3]) }): VideoBodyProps {
  return {
    resourceAddress: `dsh-resource://file/session/video/${path}`,
    content,
    wrap: false,
    sessionId: 'video' as SessionId,
    useTabInfo: () => ({ tab: { signal: new AbortController().signal } }),
    useResource: () => ({ value: undefined }),
    t: (key, params) => {
      const value = translations.get(key) ?? key
      return params === undefined ? value : value.replace('{name}', String(params.name))
    },
  } as VideoBodyProps
}

describe('VideoBody', () => {
  it.each([
    ['mp4', 'video/mp4'],
    ['m4v', 'video/mp4'],
    ['webm', 'video/webm'],
    ['ogv', 'video/ogg'],
    ['mov', 'video/quicktime'],
  ] as const)('assigns .%s bytes the %s Blob media type', async (extension, mediaType) => {
    const view = render(<VideoBody {...props(`clip.${extension}`)} />)
    const player = screen.getByLabelText(`Video preview: clip.${extension}`)
    expect(create.mock.calls[0]?.[0].type).toBe(mediaType)
    expect(player.getAttribute('src')).toBe('blob:https://preview.invalid/1')
    view.unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
  })

  it('plays inline with the browser controls and only metadata preloaded', () => {
    render(<VideoBody {...props('holiday.MP4')} />)
    const player = screen.getByLabelText('Video preview: holiday.MP4')
    expect(player.getAttribute('preload')).toBe('metadata')
    expect(player.hasAttribute('controls')).toBe(true)
    expect(player.hasAttribute('playsinline')).toBe(true)
    expect(player.hasAttribute('hidden')).toBe(false)
  })

  it('revokes replaced bytes when the file changes', () => {
    const view = render(<VideoBody {...props('clip.mp4')} />)
    const first = screen.getByLabelText('Video preview: clip.mp4')
    expect(first.getAttribute('src')).toBe('blob:https://preview.invalid/1')

    view.rerender(<VideoBody {...props('clip.mp4', { kind: 'bytes', data: new Uint8Array([9]) })} />)

    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
    expect(screen.getByLabelText('Video preview: clip.mp4').getAttribute('src')).toBe('blob:https://preview.invalid/2')
  })

  it('reports a refused Blob allocation', () => {
    create.mockImplementation(() => { throw new Error('no blob storage') })
    render(<VideoBody {...props()} />)
    expect(screen.getByRole('alert').textContent).toBe('This video could not be played.')
  })

  it('reports a playback refusal without keeping a dead player visible', () => {
    render(<VideoBody {...props()} />)
    const player = screen.getByLabelText('Video preview: clip.mp4')

    fireEvent.error(player)

    expect(screen.getByRole('alert').textContent).toBe('This video could not be played.')
    expect(screen.getByLabelText('Video preview: clip.mp4').hasAttribute('hidden')).toBe(true)
  })

  it('asks for the complete file when the bytes never arrived', () => {
    render(<VideoBody {...props('clip.mp4', { kind: 'text', text: '', pages: [], eof: true })} />)
    expect(screen.getByRole('alert').textContent).toBe('Video preview requires the complete file contents.')
  })

  it('refuses a suffix it does not declare', () => {
    expect(videoMediaType('clip.avi')).toBeUndefined()
    render(<VideoBody {...props('clip.avi')} />)
    expect(screen.getByRole('alert').textContent).toBe('Video preview requires the complete file contents.')
  })
})
