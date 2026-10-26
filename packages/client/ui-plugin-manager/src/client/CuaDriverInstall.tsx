/**
 * Cua driver setup for the computer-use package page: detects the installed
 * driver, shows which executable answered, and runs the upstream installer with
 * its progress streamed in.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import css from './PluginManagerPage.module.css'
import type { Translate } from './presentation.ts'

/** What one detection reported. */
interface DriverCheck {
  readonly installed: boolean
  readonly version: string | null
  readonly path: string | null
}

type InstallState =
  | { phase: 'checking' }
  | { phase: 'missing'; detail: string | null }
  | { phase: 'installed'; version: string | null; path: string | null }
  | { phase: 'installing'; lines: string[] }
  | { phase: 'error'; message: string }

/** Detect the driver once and let the user install or re-check it. */
export function CuaDriverSetup({ t }: { readonly t: Translate }): ReactNode {
  const [state, setState] = useState<InstallState>({ phase: 'checking' })
  // A stream that outlives the page would keep writing to an unmounted tree.
  const live = useRef(true)

  const check = useCallback(async (): Promise<void> => {
    setState({ phase: 'checking' })
    try {
      const response = await fetch('/api/computer-use/cua-driver/check')
      if (!response.ok) {
        setState({ phase: 'missing', detail: `HTTP ${String(response.status)}` })
        return
      }
      const result = await response.json() as DriverCheck
      if (!live.current) return
      setState(result.installed
        ? { phase: 'installed', version: result.version, path: result.path }
        : { phase: 'missing', detail: null })
    } catch (error) {
      if (!live.current) return
      setState({ phase: 'missing', detail: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    live.current = true
    void check()
    return () => { live.current = false }
  }, [check])

  const install = useCallback(async (): Promise<void> => {
    setState({ phase: 'installing', lines: [] })
    try {
      const response = await fetch('/api/computer-use/cua-driver/install', { method: 'POST' })
      if (!response.ok || response.body === null) {
        setState({ phase: 'error', message: `HTTP ${String(response.status)}` })
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done || !live.current) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') continue
          const message = frameOf(line)
          if (message === undefined) continue
          if (message.type === 'log' && message.line !== undefined) {
            // The installer's own path setup decides where the driver lands, so
            // its output stays the account of what happened.
            setState(prev => prev.phase === 'installing'
              ? { phase: 'installing', lines: [...prev.lines, message.line as string].slice(-40) }
              : prev)
          } else if (message.type === 'done') {
            if (message.exitCode !== 0) setState({ phase: 'error', message: `Exit code ${String(message.exitCode)}` })
            else await check()
          } else if (message.type === 'error') {
            setState({ phase: 'error', message: message.message ?? 'Unknown error' })
          }
        }
      }
    } catch (error) {
      if (!live.current) return
      setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [check])

  if (state.phase === 'checking') {
    return <div className={css.cuaDriverStatus} role="status">{t('cuaDriverChecking')}</div>
  }
  if (state.phase === 'installing') {
    return (
      <div className={css.cuaDriverInstall}>
        <div className={css.cuaDriverProgress} role="log" aria-label={t('cuaDriverProgressLabel')}>
          {state.lines.map((line, index) => <div key={index} className={css.cuaDriverLogLine}>{line}</div>)}
        </div>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div className={css.cuaDriverInstall}>
        <span className={css.cuaDriverError}>{t('cuaDriverError')}: {state.message}</span>
        <button type="button" className={css.cuaDriverButton} onClick={() => { void install() }}>{t('cuaDriverRetry')}</button>
      </div>
    )
  }
  if (state.phase === 'installed') {
    return (
      <div className={css.cuaDriverInstall}>
        <span className={css.cuaDriverSuccess} role="status">
          {t('cuaDriverPresent', { version: state.version ?? '?' })}
        </span>
        {state.path === null ? null : <code className={css.cuaDriverPath}>{state.path}</code>}
        <button type="button" className={css.cuaDriverButton} onClick={() => { void check() }}>{t('cuaDriverRecheck')}</button>
      </div>
    )
  }
  return (
    <div className={css.cuaDriverInstall}>
      <span className={css.cuaDriverWarning} role="status">
        {t('cuaDriverMissing')}
        {state.detail === null ? null : `（${state.detail}）`}
      </span>
      <button type="button" className={css.cuaDriverButton} onClick={() => { void install() }}>{t('cuaDriverInstall')}</button>
    </div>
  )
}

/** One newline-delimited installer frame, or undefined for a line that is not one. */
function frameOf(line: string): { type: string; line?: string; message?: string; exitCode?: number } | undefined {
  try {
    return JSON.parse(line) as { type: string; line?: string; message?: string; exitCode?: number }
  } catch {
    // The installer stream is newline-delimited JSON; a partial or foreign line
    // carries no frame and is dropped rather than failing the stream.
    return undefined
  }
}
