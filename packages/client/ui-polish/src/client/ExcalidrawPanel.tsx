// Excalidraw canvas view tab: embeds the Excalidraw React component directly
// (no iframe, no separate page) so the whiteboard lives in the DSH document
// and follows its theme natively. The panel loads the workspace scene file
// through /scene/current, hands it to Excalidraw's imperative API, and persists
// change notifications back via /scene/write. Excalidraw + mermaid are inlined
// into the plugin client bundle; react/react-dom come from the platform.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
// Excalidraw ships no auto-injected stylesheet; the tsdown plain-css plugin
// inlines this exact specifier into a <style> tag in the client bundle.
import '@excalidraw/excalidraw/dist/prod/index.css'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import css from './ExcalidrawPanel.module.css'

/** Full component props: conversation view share + the ui-polish locale seat. */
export type ExcalidrawPanelProps = PropsRuntime<'conversation.view'> & PropsLocale<'ui-polish'>

/** The workspace path owning the current session, if any. */
function workspacePathOf(
  sessionId: string | undefined,
  items: readonly WorkspaceListState['items'][number][],
): string | undefined {
  if (sessionId === undefined) return undefined
  return items.find(item => item.sessionIds.includes(sessionId as never))?.path
}

/** A scene payload: the serializable Excalidraw scene (elements + appState). */
interface ScenePayload {
  elements: unknown[]
  appState: Record<string, unknown>
}

/** The DSH body attribute the theme presenter toggles for the dark palette. */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * AppState fields worth persisting: the document-level appearance/geometry
 * only. Live runtime state (selection, active tool, editing, dialogs) must not
 * round-trip; Excalidraw supplies correct defaults for it.
 */
const PERSISTED_APPSTATE_KEYS = new Set([
  'viewBackgroundColor',
  // 'theme' is deliberately NOT persisted: the canvas theme always follows the
  // DSH theme (this component's `theme` prop is driven by body[data-ds-dark-theme]),
  // so a saved scene must never override it on reload.
  'gridSize',
  'gridStep',
  'exportBackground',
  'exportScale',
  'exportEmbedScene',
  'exportWithDarkMode',
  'currentItemStrokeColor',
  'currentItemBackgroundColor',
  'currentItemFillStyle',
  'currentItemStrokeWidth',
  'currentItemStrokeStyle',
  'currentItemRoughness',
  'currentItemOpacity',
  'currentItemFontFamily',
  'currentItemFontSize',
  'currentItemTextAlign',
  'currentItemStartArrowhead',
  'currentItemEndArrowhead',
  'currentItemRoundness',
  'currentItemArrowType',
  'scrollX',
  'scrollY',
  'zoom',
  'name',
])

/** Keep only the persistable document subset of an AppState record. */
function sanitizeAppState(appState: object): Record<string, unknown> {
  const clean: Record<string, unknown> = {}
  for (const key of PERSISTED_APPSTATE_KEYS) {
    const value = (appState as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (value instanceof Map || value instanceof Set) continue
    clean[key] = value
  }
  return clean
}

/**
 * A stable fingerprint of a scene's element set, keyed on the identity fields
 * the model's draw tool produces (id/type/text) plus the element count. Field
 * order and runtime fields (seed/versionNonce/index) do not affect it, so the
 * same content yields the same fingerprint regardless of serialization order —
 * this is what lets the poll loop tell "the model drew something new" apart
 * from "the canvas saved its own edits".
 */
function sceneFingerprint(scene: unknown): string | null {
  const record = (typeof scene === 'object' && scene !== null) ? scene as Record<string, unknown> : null
  if (record === null || !Array.isArray(record['elements'])) return null
  const parts = (record['elements'] as unknown[]).map((raw) => {
    const element = (typeof raw === 'object' && raw !== null) ? raw as Record<string, unknown> : {}
    const id = typeof element['id'] === 'string' ? element['id'] : ''
    const type = typeof element['type'] === 'string' ? element['type'] : ''
    const rawText = typeof element['text'] === 'string' ? element['text'] : ''
    return `${id}:${type}:${rawText}`
  })
  return `${parts.join('|')}#${parts.length}`
}

/**
 * Render the Excalidraw canvas as a conversation view tab, embedded directly.
 * @param props - composed slot props.
 * @returns the panel element tree.
 */
export function ExcalidrawPanel({ useSession, useWorkspaces, t }: ExcalidrawPanelProps) {
  const sessionId = useSession(s => s.sessionId)
  const workspaceItems = useWorkspaces(s => s.items)
  const cwd = workspacePathOf(sessionId, workspaceItems)
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadedOnce = useRef(false)
  const saveTimer = useRef<number | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.body.hasAttribute(DARK_ATTRIBUTE) ? 'dark' : 'light')
  // Fingerprint of the scene currently applied to the canvas. Updated on every
  // apply (initial load, model-driven reload) and after every self-save, so the
  // poll loop can detect a model-written scene change without reloading the
  // canvas's own edits.
  const lastAppliedFingerprint = useRef<string | null>(null)

  // Follow the DSH theme natively (same document, no postMessage).
  useEffect(() => {
    const sync = (): void => {
      setTheme(document.body.hasAttribute(DARK_ATTRIBUTE) ? 'dark' : 'light')
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
    return () => { observer.disconnect() }
  }, [])

  // Load the workspace scene once the imperative API is ready.
  const loadScene = useCallback((api: ExcalidrawImperativeAPI): void => {
    if (cwd === undefined) return
    fetch('/scene/current', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
      .then(async (response) => {
        if (response.status === 404) return // blank start
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
        const scene = body as unknown as ScenePayload
        api.updateScene({
          elements: scene.elements as never,
          appState: sanitizeAppState(scene.appState) as never,
        })
        const fingerprint = sceneFingerprint(scene)
        if (fingerprint !== null) lastAppliedFingerprint.current = fingerprint
      })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)) })
  }, [cwd])

  // Reset the load guard when the workspace changes.
  useEffect(() => {
    loadedOnce.current = false
    lastAppliedFingerprint.current = null
  }, [cwd])

  const handleApi = useCallback((api: ExcalidrawImperativeAPI): void => {
    apiRef.current = api
    if (!loadedOnce.current && cwd !== undefined) {
      loadedOnce.current = true
      loadScene(api)
    }
  }, [cwd, loadScene])

  // Persist change notifications back to the workspace scene file (debounced).
  const handleChange = useCallback((elements: readonly unknown[], appState: object): void => {
    if (cwd === undefined) return
    const scene: ScenePayload = { elements: [...elements], appState: sanitizeAppState(appState) }
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      setSaving(true)
      fetch('/scene/write', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, scene: JSON.stringify(scene) }),
      })
        .then(response => response.json())
        .then((body: Record<string, unknown>) => {
          if (body['ok'] !== true) throw new Error(typeof body.error === 'string' ? body.error : 'save failed')
          // The file now matches the canvas; remember it so the poll loop does
          // not treat this self-save as a model-driven change.
          const fingerprint = sceneFingerprint(scene)
          if (fingerprint !== null) lastAppliedFingerprint.current = fingerprint
        })
        .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)) })
        .finally(() => { setSaving(false) })
    }, 800)
  }, [cwd])

  // Poll the scene file: when the model draws via excalidraw_draw (or rewrites
  // the scene), the fingerprint changes and the canvas reloads it live, so
  // model-created content appears without leaving and re-entering the tab.
  useEffect(() => {
    if (cwd === undefined) return
    let cancelled = false
    const poll = async (): Promise<void> => {
      // The API may not be ready yet on the first tick; skip until it is.
      if (cancelled || apiRef.current === null) return
      try {
        const response = await fetch('/scene/current', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd }),
        })
        if (response.status === 404) return
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) return
        const fingerprint = sceneFingerprint(body)
        if (fingerprint === null || fingerprint === lastAppliedFingerprint.current) return
        // A different scene landed on disk (model drew) — apply it.
        const scene = body as unknown as ScenePayload
        console.log('[dsh-poll] applying scene', fingerprint, 'was', lastAppliedFingerprint.current, 'elements', scene.elements.length)
        apiRef.current.updateScene({
          elements: scene.elements as never,
          appState: sanitizeAppState(scene.appState) as never,
        })
        lastAppliedFingerprint.current = fingerprint
      } catch {
        // Transient fetch failure — the next poll retries.
      }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [cwd])

  const frame = useMemo(() => {
    if (cwd === undefined) return null
    return (
      <Excalidraw
        excalidrawAPI={handleApi}
        onChange={handleChange}
        theme={theme}
      />
    )
  }, [cwd, handleApi, handleChange, theme])

  // Export the canvas as a PNG download (viewBackgroundColor as the backdrop).
  const [exporting, setExporting] = useState(false)
  const exportPng = useCallback(async (): Promise<void> => {
    const api = apiRef.current
    if (api === null || exporting) return
    setExporting(true)
    setError(null)
    try {
      const elements = api.getSceneElements()
      const appState = api.getAppState() as Record<string, unknown>
      /* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-argument --
       * excalidraw's appState is a loose record by design */
      const viewBackgroundColor = appState['viewBackgroundColor']
      const background = typeof viewBackgroundColor === 'string' ? viewBackgroundColor : '#ffffff'
      const blob = await exportToBlob({
        elements,
        appState: appState as never,
        files: api.getFiles() as never,
        mimeType: 'image/png',
        background,
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      const name = typeof api.getName() === 'string' && api.getName().length > 0 ? api.getName() : 'canvas'
      anchor.href = url
      anchor.download = `${name}.png`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => { URL.revokeObjectURL(url) }, 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }, [exporting])

  return (
    <div className={css.view} data-ui-polish-excalidraw="">
      <div className={css.toolbar}>
        <span className={css.title}>{t('excalidraw.title')}</span>
        {cwd !== undefined && <span className={css.cwd}>{cwd}</span>}
        <span className={css.toolbarActions}>
          {saving && <span className={css.saving}>{t('excalidraw.saving')}</span>}
          <button
            type="button" className={css.export}
            disabled={exporting || cwd === undefined}
            onClick={() => { void exportPng() }}
          >
            {t('excalidraw.export')}
          </button>
        </span>
      </div>
      {error !== null && <div className={css.error}>{error}</div>}
      {cwd === undefined
        ? <div className={css.notice}>{t('git.noWorkspace')}</div>
        : <div className={css.canvas}>{frame}</div>}
    </div>
  )
}
