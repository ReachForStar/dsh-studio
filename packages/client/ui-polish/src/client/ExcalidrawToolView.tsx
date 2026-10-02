// Excalidraw tool call view: a dedicated card for `excalidraw_draw` /
// `excalidraw_write` / `excalidraw_export` that renders an "Open in canvas"
// button (form ①), an inline SVG thumbnail of the resulting scene (form ③),
// and auto-switches to the canvas tab when a live result arrives (form ②).

import { useEffect, useRef } from 'react'
import { Button, IconInspectOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ExcalidrawToolView.module.css'

/** Full component props: the keyed toolview payload plus the ui-polish locale seat. */
export type ExcalidrawToolViewProps = ToolCallViewProps & PropsLocale<'ui-polish'>

/** The conversation view tab id for the Excalidraw canvas panel. */
const EXCALIDRAW_VIEW = 'excalidraw'

/** Locale key for the per-tool title, falling back to a generic label. */
function titleKeyOf(toolName: string): 'excalidraw.drawTitle' | 'excalidraw.writeTitle' | 'excalidraw.exportTitle' {
  if (toolName === 'excalidraw_write') return 'excalidraw.writeTitle'
  if (toolName === 'excalidraw_export') return 'excalidraw.exportTitle'
  return 'excalidraw.drawTitle'
}

/** Extract the preview SVG string from a tool result's `meta` payload, if present. */
function previewSvgOf(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null
  const svg = (meta as Record<string, unknown>)['previewSvg']
  return typeof svg === 'string' ? svg : null
}

/** Build a short argument summary for the running/start card. */
function argsSummary(toolName: string, argsRaw: string): string {
  if (toolName === 'excalidraw_write') {
    return `${argsRaw.length} chars`
  }
  try {
    const parsed = JSON.parse(argsRaw) as { elements?: unknown[] }
    return `${parsed.elements?.length ?? 0} shapes`
  } catch {
    return ''
  }
}

/**
 * Render one Excalidraw tool call as a dedicated card with a canvas-tab action,
 * an optional SVG thumbnail, and a live-result auto-switch side effect.
 * @param props - keyed toolview payload plus the ui-polish locale seat.
 * @returns the dedicated Excalidraw tool card.
 */
export function ExcalidrawToolView(props: ExcalidrawToolViewProps) {
  const { phase, block, toolName, openView, useSession, t } = props

  // Form ②: auto-switch to the canvas tab when a live (non-replay) successful
  // result arrives. `useSession(running)` distinguishes live SSE from replay:
  // a replayed session is not running, so the side effect is suppressed.
  // A ref guards dedup so the same callId only triggers once.
  const running = useSession(s => s.running)
  const autoSwitchedRef = useRef(false)
  useEffect(() => {
    if (phase !== 'result') return
    if (autoSwitchedRef.current) return
    if (!running) return
    if (block.isError) return
    if (openView === undefined) return
    autoSwitchedRef.current = true
    openView(EXCALIDRAW_VIEW, '')
  }, [phase, block, running, openView])

  const titleKey = titleKeyOf(toolName)
  const previewSvg = phase === 'result' ? previewSvgOf(block.meta) : null

  if (phase === 'preparing') {
    return (
      <div className={css.card} data-tool={toolName} data-state="preparing">
        <div className={css.row}>
          <span className={css.leading}><IconInspectOutlineRegular size={14} /></span>
          <TextShimmer active>
            <span className={css.title}>{t(titleKey)}</span>
          </TextShimmer>
        </div>
      </div>
    )
  }

  if (phase === 'start') {
    const summary = argsSummary(toolName, block.argsRaw)
    return (
      <div className={css.card} data-tool={toolName} data-state="running">
        <div className={css.row}>
          <span className={css.leading}><IconInspectOutlineRegular size={14} /></span>
          <TextShimmer active>
            <span className={css.title}>{t(titleKey)}</span>
            {summary !== '' && <span className={css.summary}> · {summary}</span>}
          </TextShimmer>
        </div>
        <div className={css.actions}>
          <Button variant="outline" onClick={() => openView?.(EXCALIDRAW_VIEW, '')}>
            {t('excalidraw.openInCanvas')}
          </Button>
        </div>
      </div>
    )
  }

  // phase === 'result'
  const errorSummary = block.isError ? t('excalidraw.toolFailed') : null
  return (
    <div className={css.card} data-tool={toolName} data-state={block.isError ? 'error' : 'ok'}>
      <div className={css.row}>
        <span className={css.leading}><IconInspectOutlineRegular size={14} /></span>
        <span className={css.title}>{t(titleKey)}</span>
        {errorSummary !== null && <span className={`${css.summary} ${css.errorSummary}`}>{errorSummary}</span>}
      </div>
      {previewSvg !== null && (
        <img
          className={css.preview}
          src={`data:image/svg+xml;utf8,${encodeURIComponent(previewSvg)}`}
          alt=""
        />
      )}
      <div className={css.actions}>
        <Button variant="outline" onClick={() => openView?.(EXCALIDRAW_VIEW, '')}>
          {t('excalidraw.openInCanvas')}
        </Button>
      </div>
    </div>
  )
}