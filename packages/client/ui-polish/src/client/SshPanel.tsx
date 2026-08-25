/**
 * SSH/SFTP panel: a conversation.view tab providing an interactive PTY
 * terminal (xterm.js) and a streaming SFTP file manager. The connection
 * selector lists stored SSH connections; the PTY and SFTP operate on the
 * selected connection. PTY output arrives on the host frame stream; SFTP
 * file transfer uses the host-only download channel (GET) and a carrier
 * POST upload route.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment,
 *   @typescript-eslint/no-unsafe-member-access,
 *   @typescript-eslint/no-unsafe-argument,
 *   typescript/no-confusing-void-expression */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SshPanel.module.css'

/** Full component props: conversation view share + the ui-polish locale seat. */
export type SshPanelProps = PropsRuntime<'conversation.view'> & PropsLocale<'ui-polish'>

interface SshConnectionView {
  id: string
  name: string
  host: string
  port: number
  user: string
  authKind: 'password' | 'privateKey'
}

interface SftpEntryView {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtime: number
}

interface HostFrameLike {
  type: string
  ptyId?: string
  data?: string
  exitCode?: number | null
  signal?: string | null
  dropped?: boolean
}

/**
 * Send a unary RPC to the apiproxy carrier. The carrier expects POST with
 * a JSON `ClientRequest` envelope; the response is a `ServerResponse`
 * envelope whose `result` carries the ok/err payload.
 */
async function rpc(
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }> {
  const rpcId = crypto.randomUUID()
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (!res.ok) {
    const text = await res.text()
    return { ok: false, error: { message: `${res.status}: ${text}` } }
  }
  const body = await res.json()
  const result = body.result as { ok: true; value: unknown } | { ok: false; error: { message: string } } | undefined
  if (result === undefined) return { ok: false, error: { message: 'malformed response' } }
  if (result.ok) return { ok: true, value: result.value }
  return { ok: false, error: result.error }
}

/**
 * Subscribe to the host frame stream for PTY output/exit frames.
 * Returns an unsubscribe function.
 */
function subscribeHostFrames(
  onFrame: (frame: HostFrameLike) => void,
  onDrop: (ptyId: string) => void,
): () => void {
  const ac = new AbortController()
  const url = new URL('/api/events.host', window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url.toString())
  const inbox: HostFrameLike[] = []
  let wake: (() => void) | undefined
  let stopped = false

  const enqueue = (frame: HostFrameLike): void => {
    inbox.push(frame)
    wake?.()
    wake = undefined
  }

  const handleMessage = (event: MessageEvent): void => {
    try {
      const full = JSON.parse(String(event.data))
      const frame = full.payload as HostFrameLike | undefined
      if (frame === undefined) return
      if (frame.type === 'ssh/pty/output' || frame.type === 'ssh/pty/exit') {
        enqueue(frame)
      }
    } catch { /* malformed frame — ignore */ }
  }

  const handleClose = (): void => {
    stopped = true
    wake?.()
  }

  socket.addEventListener('open', () => {
    // Stream is open; start pumping.
    void pump()
  })
  socket.addEventListener('message', handleMessage)
  socket.addEventListener('close', handleClose, { once: true })
  ac.signal.addEventListener('abort', () => {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close()
    }
  }, { once: true })

  async function pump(): Promise<void> {
    while (!stopped) {
      while (inbox.length > 0) {
        const frame = inbox.shift() as HostFrameLike
        if (frame.type === 'ssh/pty/output' && frame.ptyId && frame.data) {
          onFrame(frame)
        } else if (frame.type === 'ssh/pty/exit' && frame.ptyId) {
          onDrop(frame.ptyId)
        }
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
  }

  return () => {
    stopped = true
    ac.abort()
    socket.removeEventListener('message', handleMessage)
    socket.removeEventListener('close', handleClose)
    wake?.()
    wake = undefined
  }
}

/**
 * Render the SSH/SFTP panel as a conversation view tab.
 */
export function SshPanel({ t }: SshPanelProps) {
  const [connections, setConnections] = useState<SshConnectionView[]>([])
  const [selectedConn, setSelectedConn] = useState<string | null>(null)
  const [terminalEl, setTerminalEl] = useState<HTMLElement | null>(null)
  const [sftpPath, setSftpPath] = useState('/root')
  const [sftpEntries, setSftpEntries] = useState<SftpEntryView[]>([])
  const [sftpLoading, setSftpLoading] = useState(false)
  const [sftpError, setSftpError] = useState<string | null>(null)
  const [ptyError, setPtyError] = useState<string | null>(null)
  const [ptyOpen, setPtyOpen] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [connectionsLoaded, setConnectionsLoaded] = useState(false)

  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const fitInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const hostUnsubRef = useRef<(() => void) | null>(null)
  const sftpPathRef = useRef(sftpPath)
  sftpPathRef.current = sftpPath

  // Load connections on mount.
  useEffect(() => {
    void (async () => {
      try {
        const result = await rpc('ssh.list', {})
        if (result.ok) {
          const value = result.value as { connections: SshConnectionView[] } | undefined
          setConnections(value?.connections ?? [])
        }
      } catch { /* connection list is optional */ }
      finally { setConnectionsLoaded(true) }
    })()
  }, [])

  // Subscribe to host frames for PTY output/exit.
  useEffect(() => {
    const unsub = subscribeHostFrames(
      (frame) => {
        if (frame.ptyId !== ptyIdRef.current) return
        const term = termRef.current
        if (term === null || frame.data === undefined) return
        const bytes = atob(frame.data)
        const bytesArr = new Uint8Array(bytes.length)
        for (let i = 0; i < bytes.length; i++) bytesArr[i] = bytes.charCodeAt(i)
        term.write(bytesArr)
      },
      (ptyId) => {
        if (ptyId !== ptyIdRef.current) return
        ptyIdRef.current = null
        setPtyOpen(false)
        if (fitInterval.current) { clearInterval(fitInterval.current); fitInterval.current = null }
        termRef.current?.dispose()
        termRef.current = null
        setTerminalEl(null)
      },
    )
    hostUnsubRef.current = unsub
    return () => { unsub(); hostUnsubRef.current = null }
  }, [])

  // Open PTY when a connection is selected.
  const openPty = useCallback(async () => {
    if (!selectedConn || !terminalEl) return
    setPtyError(null)
    try {
      const result = await rpc('ssh.pty.open', {
        connectionId: selectedConn, cols: 80, rows: 24,
      })
      if (!result.ok) {
        setPtyError(result.error?.message ?? 'failed to open PTY')
        return
      }
      const ptyId = (result.value as { ptyId: string } | undefined)?.ptyId ?? ''
      ptyIdRef.current = ptyId
      setPtyOpen(true)

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
        fontSize: 14,
        theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
        convertEol: true,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(terminalEl)
      fit.fit()
      termRef.current = term
      fitRef.current = fit

      term.onData((data: string) => {
        const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(data)))
        void rpc('ssh.pty.write', { ptyId, data: b64 })
      })

      fitInterval.current = setInterval(() => {
        fit.fit()
        void rpc('ssh.pty.resize', { ptyId, cols: term.cols, rows: term.rows })
      }, 2000)

      term.focus()

      // After opening, resolve the home directory for SFTP initial path.
      void (async () => {
        try {
          const homeResult = await rpc('ssh.sftp.stat', {
            connectionId: selectedConn, path: '~',
          })
          if (homeResult.ok) {
            const value = homeResult.value as { entry?: SftpEntryView } | undefined
            const homePath = value?.entry?.path
            if (homePath && homePath.startsWith('/')) {
              setSftpPath(homePath)
              void listDir(homePath)
            }
          }
        } catch { /* cwd detection is best-effort */ }
      })()
    } catch (error) {
      setPtyError(error instanceof Error ? error.message : String(error))
    }
  }, [selectedConn, terminalEl])

  // SFTP: list directory.
  const listDir = useCallback(async (path: string) => {
    if (!selectedConn) return
    setSftpLoading(true)
    setSftpError(null)
    try {
      const result = await rpc('ssh.sftp.list', {
        connectionId: selectedConn, path,
      })
      if (result.ok) {
        const value = result.value as { entries: SftpEntryView[] } | undefined
        setSftpEntries(value?.entries ?? [])
        setSftpPath(path)
      } else {
        setSftpError(result.error?.message ?? 'failed to list directory')
      }
    } catch (error) {
      setSftpError(error instanceof Error ? error.message : String(error))
    } finally {
      setSftpLoading(false)
    }
  }, [selectedConn])

  // Clean up PTY on unmount.
  useEffect(() => {
    return () => {
      if (fitInterval.current) clearInterval(fitInterval.current)
      if (ptyIdRef.current) {
        void rpc('ssh.pty.close', { ptyId: ptyIdRef.current }).catch(() => undefined)
      }
      termRef.current?.dispose()
      termRef.current = null
      ptyIdRef.current = null
    }
  }, [])

  // SFTP: navigate into a directory.
  const navigateDir = useCallback((entry: SftpEntryView) => {
    if (entry.type === 'directory') void listDir(entry.path)
  }, [listDir])

  // SFTP: go to parent directory.
  const goParent = useCallback(() => {
    const parent = sftpPath === '/' ? '/' : sftpPath.replace(/\/[^/]+$/, '') || '/'
    void listDir(parent)
  }, [sftpPath, listDir])

  // SFTP: download a file via the host-only GET channel.
  const downloadFile = useCallback(async (entry: SftpEntryView) => {
    if (!selectedConn) return
    setDownloading(entry.name)
    try {
      const url = `/api/ssh/sftp/download?connectionId=${encodeURIComponent(selectedConn)}&path=${encodeURIComponent(entry.path)}`
      const response = await fetch(url)
      if (!response.ok) throw new Error(`download failed: ${response.status}`)
      const blob = await response.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = entry.name
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (error) {
      setSftpError(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloading(null)
    }
  }, [selectedConn])

  // SFTP: upload via file input.
  const handleUploadClick = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (file && selectedConn) {
        const targetPath = sftpPath === '/' ? `/${file.name}` : `${sftpPath}/${file.name}`
        try {
          const response = await fetch(
            `/api/ssh/sftp/upload?connectionId=${encodeURIComponent(selectedConn)}&path=${encodeURIComponent(targetPath)}`,
            { method: 'POST', body: file },
          )
          if (!response.ok) throw new Error(`upload failed: ${response.status}`)
          void listDir(sftpPath)
        } catch (error) {
          setSftpError(error instanceof Error ? error.message : String(error))
        }
      }
    }
    input.click()
  }, [selectedConn, sftpPath, listDir])

  // SFTP: mkdir.
  const handleMkdir = useCallback(() => {
    const name = window.prompt(t('ssh.mkdirPrompt'))
    if (!name) return
    const path = sftpPath === '/' ? `/${name}` : `${sftpPath}/${name}`
    void (async () => {
      try {
        const result = await rpc('ssh.sftp.mkdir', { connectionId: selectedConn, path })
        if (result.ok) { void listDir(sftpPath) } else { setSftpError(result.error?.message ?? 'failed to create directory') }
      } catch (error) {
        setSftpError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [selectedConn, sftpPath, listDir, t])

  // SFTP: remove.
  const removeEntry = useCallback(async (entry: SftpEntryView) => {
    if (!selectedConn) return
    try {
      const result = await rpc('ssh.sftp.remove', { connectionId: selectedConn, path: entry.path })
      if (result.ok) { void listDir(sftpPath) } else { setSftpError(result.error?.message ?? 'failed to remove') }
    } catch (error) {
      setSftpError(error instanceof Error ? error.message : String(error))
    }
  }, [selectedConn, sftpPath, listDir])

  // SFTP: rename.
  const renameEntry = useCallback(async (entry: SftpEntryView) => {
    if (!selectedConn) return
    const newName = window.prompt(t('ssh.renamePrompt'), entry.name)
    if (newName === null || newName === entry.name) return
    const toPath = sftpPath === '/' ? `/${newName}` : `${sftpPath}/${newName}`
    try {
      const result = await rpc('ssh.sftp.rename', { connectionId: selectedConn, path: entry.path, toPath })
      if (result.ok) { void listDir(sftpPath) } else { setSftpError(result.error?.message ?? 'failed to rename') }
    } catch (error) {
      setSftpError(error instanceof Error ? error.message : String(error))
    }
  }, [selectedConn, sftpPath, listDir, t])

  return (
    <div className={css.view} data-ui-polish-ssh="">
      <div className={css.header}>
        <span className={css.title}>{t('ssh.title')}</span>
        <select
          className={css.select}
          value={selectedConn ?? ''}
          onChange={e => setSelectedConn(e.target.value || null)}
          disabled={!connectionsLoaded || connections.length === 0}
        >
          <option value="">
            {connectionsLoaded && connections.length === 0
              ? t('ssh.noConnections')
              : t('ssh.selectConnection')}
          </option>
          {connections.map(conn => (
            <option key={conn.id} value={conn.id}>
              {conn.name} ({conn.host}:{conn.port})
            </option>
          ))}
        </select>
        {selectedConn && (
          <button className={css.button} onClick={() => void openPty()}>
            {t('ssh.openTerminal')}
          </button>
        )}
      </div>

      {ptyError && <div className={css.error}>{ptyError}</div>}

      {/* PTY terminal */}
      <div className={css.terminal} style={{ display: terminalEl ? 'block' : 'none' }}>
        <div ref={(el) => { if (el) setTerminalEl(el) }} className={css.terminalInner} />
        {ptyOpen && (
          <button
            className={css.closeButton}
            onClick={() => {
              const id = ptyIdRef.current
              if (id) void rpc('ssh.pty.close', { ptyId: id }).catch(() => undefined)
              ptyIdRef.current = null
              setPtyOpen(false)
              if (fitInterval.current) { clearInterval(fitInterval.current); fitInterval.current = null }
              termRef.current?.dispose()
              termRef.current = null
              setTerminalEl(null)
            }}
          >
            {t('ssh.closeTerminal')}
          </button>
        )}
      </div>

      {/* SFTP file manager */}
      <div className={css.sftp}>
        <div className={css.sftpHeader}>
          <button className={css.button} disabled={!selectedConn || sftpPath === '/'} onClick={goParent} style={{ marginRight: 8 }}>
            ..
          </button>
          <span className={css.sftpPath}>{sftpPath}</span>
          <div className={css.sftpActions}>
            <button className={css.button} disabled={!selectedConn || sftpLoading} onClick={() => void listDir(sftpPath)}>
              {t('ssh.refresh')}
            </button>
            <button className={css.button} disabled={!selectedConn} onClick={handleMkdir}>
              {t('ssh.mkdir')}
            </button>
            <button className={css.button} disabled={!selectedConn} onClick={handleUploadClick}>
              {t('ssh.upload')}
            </button>
          </div>
        </div>
        {sftpError && <div className={css.error}>{sftpError}</div>}
        {sftpLoading && <div className={css.loading}>{t('ssh.loading')}</div>}
        {!sftpLoading && (
          <table className={css.table}>
            <thead>
              <tr>
                <th>{t('ssh.name')}</th>
                <th>{t('ssh.type')}</th>
                <th>{t('ssh.size')}</th>
                <th>{t('ssh.modified')}</th>
                <th>{t('ssh.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sftpEntries.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', opacity: 0.5 }}>
                    {selectedConn ? t('ssh.empty') : t('ssh.selectConnection')}
                  </td>
                </tr>
              )}
              {sftpEntries.map(entry => (
                <tr key={entry.path} onClick={() => navigateDir(entry)} className={entry.type === 'directory' ? css.dirRow : undefined}>
                  <td>{entry.name}</td>
                  <td>{entry.type}</td>
                  <td>{entry.type === 'file' ? formatSize(entry.size) : '—'}</td>
                  <td>{new Date(entry.mtime).toLocaleString()}</td>
                  <td className={css.rowActions} onClick={e => e.stopPropagation()}>
                    {entry.type === 'file' && (
                      <button className={css.actionBtn} disabled={downloading === entry.name} onClick={() => void downloadFile(entry)}>
                        {downloading === entry.name ? t('ssh.downloading') : t('ssh.download')}
                      </button>
                    )}
                    <button className={css.actionBtn} onClick={() => void renameEntry(entry)}>{t('ssh.rename')}</button>
                    <button className={css.actionBtn} onClick={() => void removeEntry(entry)}>{t('ssh.remove')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/** Format a byte count for display. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
