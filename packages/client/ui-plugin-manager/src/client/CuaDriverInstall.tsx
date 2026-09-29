/**
 * Cua Driver install widget: checks whether the driver is in PATH and offers
 * a one-click install that streams progress from the Host-side install route.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import css from './PluginManagerPage.module.css'
import type { Translate } from './presentation.ts'

type InstallState =
  | { phase: 'checking' }
  | { phase: 'missing' }
  | { phase: 'installed'; version: string | null }
  | { phase: 'installing'; lines: string[] }
  | { phase: 'done' }
  | { phase: 'error'; message: string }

/** Check whether cua-driver is available, and if not, let the user install it. */
export function CuaDriverInstall({ t }: { readonly t: Translate }): ReactNode {
  const [state, setState] = useState<InstallState>({ phase: 'checking' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/computer-use/cua-driver/check')
        if (!response.ok) { if (!cancelled) setState({ phase: 'missing' }); return }
        const result = await response.json() as { installed: boolean; version: string | null }
        if (!cancelled) setState(result.installed ? { phase: 'installed', version: result.version } : { phase: 'missing' })
      } catch {
        if (!cancelled) setState({ phase: 'missing' })
      }
    })()
    return () => { cancelled = true }
  }, [])

  const install = useCallback(async () => {
    setState({ phase: 'installing', lines: [] })
    try {
      const response = await fetch('/api/computer-use/cua-driver/install', { method: 'POST' })
      if (!response.ok || response.body === null) {
        setState({ phase: 'error', message: `HTTP ${response.status}` })
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') continue
          try {
            const message = JSON.parse(line) as { type: string; line?: string; message?: string; exitCode?: number }
            if (message.type === 'log' && message.line !== undefined) {
              setState(prev => prev.phase === 'installing' ? { phase: 'installing', lines: [...prev.lines, message.line!] } : prev)
            } else if (message.type === 'done') {
              setState(message.exitCode === 0 ? { phase: 'done' } : { phase: 'error', message: `Exit code ${message.exitCode}` })
            } else if (message.type === 'error') {
              setState({ phase: 'error', message: message.message ?? 'Unknown error' })
            }
          } catch { /* skip malformed line */ }
        }
      }
    } catch (error) {
      setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  if (state.phase === 'checking') return <div className={css.cuaDriverStatus}>{t('cuaDriverChecking')}</div>
  if (state.phase === 'installed') return null
  if (state.phase === 'done') {
    return (
      <div className={css.cuaDriverInstall}>
        <span className={css.cuaDriverSuccess}>{t('cuaDriverInstalled')}</span>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div className={css.cuaDriverInstall}>
        <span className={css.cuaDriverError}>{t('cuaDriverError')}: {state.message}</span>
        <button type="button" className={css.cuaDriverButton} onClick={install}>{t('cuaDriverRetry')}</button>
      </div>
    )
  }
  if (state.phase === 'installing') {
    return (
      <div className={css.cuaDriverInstall}>
        <div className={css.cuaDriverProgress}>
          {state.lines.slice(-5).map((line, index) => <div key={index} className={css.cuaDriverLogLine}>{line}</div>)}
        </div>
      </div>
    )
  }
  // state.phase === 'missing'
  return (
    <div className={css.cuaDriverInstall}>
      <span className={css.cuaDriverWarning}>{t('cuaDriverMissing')}</span>
      <button type="button" className={css.cuaDriverButton} onClick={install}>{t('cuaDriverInstall')}</button>
    </div>
  )
}