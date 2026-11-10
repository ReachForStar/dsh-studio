// @vitest-environment jsdom
/** Excalidraw tool card: preparing/start/result stages, argument summaries, and the canvas action. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ExcalidrawToolView } from '../src/client/ExcalidrawToolView.tsx'
import type { ExcalidrawToolViewProps } from '../src/client/ExcalidrawToolView.tsx'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'excalidraw.drawTitle': 'Draw on canvas',
  'excalidraw.writeTitle': 'Write canvas',
  'excalidraw.exportTitle': 'Export canvas',
  'excalidraw.argsShapes': '{count} shapes',
  'excalidraw.argsChars': '{count} characters',
  'excalidraw.openInCanvas': 'Open in canvas',
  'excalidraw.toolFailed': 'Canvas tool failed',
}

const t = (key: string, params?: Record<string, string | number>): string => {
  const template = COPY[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

/** Build one toolview props object for a stage. */
function props(overrides: Record<string, unknown>): ExcalidrawToolViewProps {
  return {
    callId: 'call-1',
    toolName: 'excalidraw_draw',
    useDisclosure: () => ({ open: false, setOpen: () => {} }),
    openFile: () => {},
    loadImage: async () => '',
    t,
    ...overrides,
  } as unknown as ExcalidrawToolViewProps
}

describe('ExcalidrawToolView', () => {
  it('shimmers the title while preparing', () => {
    const { container } = render(<ExcalidrawToolView {...props({ phase: 'preparing', block: {} })} />)
    expect(screen.getAllByText('Draw on canvas').length).toBeGreaterThan(0)
    expect(container.querySelector('[data-state="preparing"]')).not.toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('summarizes a running draw by its shape count', () => {
    render(<ExcalidrawToolView {...props({
      phase: 'start',
      block: { argsRaw: '{"elements":[{"id":"a"},{"id":"b"}]}' },
    })} />)
    expect(screen.getAllByText('Draw on canvas').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/2 shapes/).length).toBeGreaterThan(0)
  })

  it('summarizes a running write by its character count', () => {
    render(<ExcalidrawToolView {...props({
      phase: 'start',
      toolName: 'excalidraw_write',
      block: { argsRaw: 'abcdef' },
    })} />)
    expect(screen.getAllByText('Write canvas').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/6 characters/).length).toBeGreaterThan(0)
  })

  it('omits the summary for unparseable draw arguments', () => {
    render(<ExcalidrawToolView {...props({ phase: 'start', block: { argsRaw: '{oops' } })} />)
    expect(screen.getAllByText('Draw on canvas').length).toBeGreaterThan(0)
    expect(screen.queryAllByText(/shapes/)).toHaveLength(0)
  })

  it('counts zero shapes when the arguments carry no element list', () => {
    render(<ExcalidrawToolView {...props({ phase: 'start', block: { argsRaw: '{}' } })} />)
    expect(screen.getAllByText(/0 shapes/).length).toBeGreaterThan(0)
  })

  it('opens the canvas from the running card', () => {
    const openView = vi.fn()
    render(<ExcalidrawToolView {...props({
      phase: 'start',
      block: { argsRaw: '{"elements":[]}' },
      openView,
    })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in canvas' }))
    expect(openView).toHaveBeenCalledWith('excalidraw', '')
  })

  it('renders the SVG thumbnail from the result metadata', () => {
    render(<ExcalidrawToolView {...props({
      phase: 'result',
      toolName: 'excalidraw_export',
      block: { isError: false, meta: { previewSvg: '<svg></svg>' } },
    })} />)
    expect(screen.getAllByText('Export canvas').length).toBeGreaterThan(0)
    const image = document.querySelector('img')
    expect(image?.getAttribute('src')).toBe(`data:image/svg+xml;utf8,${encodeURIComponent('<svg></svg>')}`)
  })

  it('shows the failure summary for an error result', () => {
    const { container } = render(<ExcalidrawToolView {...props({
      phase: 'result',
      block: { isError: true, meta: null },
    })} />)
    expect(screen.getAllByText('Canvas tool failed').length).toBeGreaterThan(0)
    expect(container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('tolerates a missing openView action', () => {
    render(<ExcalidrawToolView {...props({ phase: 'result', block: { isError: false, meta: 'nope' } })} />)
    expect(() => { fireEvent.click(screen.getByRole('button', { name: 'Open in canvas' })) }).not.toThrow()
  })

  it('ignores a preview that is not an SVG string', () => {
    render(<ExcalidrawToolView {...props({ phase: 'result', block: { isError: false, meta: { previewSvg: 5 } } })} />)
    expect(document.querySelector('img')).toBeNull()
  })
})
