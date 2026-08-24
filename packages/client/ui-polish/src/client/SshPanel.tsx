/**
 * SSH/SFTP panel: a conversation.view tab providing an interactive PTY
 * terminal (xterm.js) and a streaming SFTP file manager. The connection
 * selector lists stored SSH connections; the PTY and SFTP operate on the
 * selected connection. PTY output arrives on the host frame stream; SFTP
 * file transfer uses the host-only download channel (GET) and a carrier
 * POST upload route.
 */

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

/**
 * Render the SSH/SFTP panel as a conversation view tab.
 */
export function SshPanel({ t }: SshPanelProps) {
  const [connections, setConnections] = useState<SshConnectionView[]>([])
  const [selectedConn, setSelectedConn] = useState<string | null>(null)
  const [terminalEl, setTerminalEl] = useState<HTMLElement | null>(null)
  const [sftpPath, setSftpPath] = useState('/')
  const [sftpEntries, setSftpEntries] = useState<SftpEntryView[]>([])
  const [sftpLoading, setSftpLoading] = useState(false)
  const [sftpError, setSftpError] = useState<string | null>(null)
  const [ptyError, setPtyError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)

  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const fitInterval = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load connections on mount.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/ssh.list')
        const json = await res.json()
        if (json.result?.ok) setConnections(json.result.value.connections)
      } catch { /* connection list is optional */ }
    })()
  }, [])

  // Open PTY when a connection is selected.
  const openPty = useCallback(async () => {
    if (!selectedConn || !terminalEl) return
    setPtyError(null)
    try {
      const res = await fetch('/api/ssh.pty.open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: selectedConn, cols: 80, rows: 24 }),
      })
      const json = await res.json()
      if (!json.result?.ok) {
        setPtyError(json.result?.error?.message ?? 'failed to open PTY')
        return
      }
      const { ptyId } = json.result.value
      ptyIdRef.current = ptyId

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

      term.onData((data) => {
        void fetch('/api/ssh.pty.write', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ptyId, data: btoa(unescape(encodeURIComponent(data))) }),
        })
      })

      fitInterval.current = setInterval(() => {
        fit.fit()
        void fetch('/api/ssh.pty.resize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ptyId, cols: term.cols, rows: term.rows }),
        })
      }, 2000)

      term.focus()
    } catch (error) {
      setPtyError(error instanceof Error ? error.message : String(error))
    }
  }, [selectedConn, terminalEl])

  // Clean up PTY on unmount.
  useEffect(() => {
    return () => {
      if (fitInterval.current) clearInterval(fitInterval.current)
      if (ptyIdRef.current) {
        void fetch('/api/ssh.pty.close', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ptyId: ptyIdRef.current }),
        })
      }
      termRef.current?.dispose()
      termRef.current = null
      ptyIdRef.current = null
    }
  }, [])

  // SFTP: list directory.
  const listDir = useCallback(async (path: string) => {
    if (!selectedConn) return
    setSftpLoading(true)
    setSftpError(null)
    try {
      const res = await fetch('/api/ssh.sftp.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: selectedConn, path }),
      })
      const json = await res.json()
      if (json.result?.ok) {
        setSftpEntries(json.result.value.entries)
        setSftpPath(path)
      } else {
        setSftpError(json.result?.error?.message ?? 'failed to list directory')
      }
    } catch (error) {
      setSftpError(error instanceof Error ? error.message : String(error))
    } finally {
      setSftpLoading(false)
    }
  }, [selectedConn])

  // SFTP: navigate into a directory.
  const navigateDir = useCallback((entry: SftpEntryView) => {
    if (entry.type === 'directory') void listDir(entry.path)
  }, [listDir])

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
        const res = await fetch('/api/ssh.sftp.mkdir', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ connectionId: selectedConn, path }),
        })
        const json = await res.json()
        if (json.result?.ok) void listDir(sftpPath)
        else setSftpError(json.result?.error?.message ?? 'failed to create directory')
      } catch (error) {
        setSftpError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [selectedConn, sftpPath, listDir, t])

  // SFTP: remove.
  const removeEntry = useCallback(async (entry: SftpEntryView) => {
    if (!selectedConn) return
    try {
      const res = await fetch('/api/ssh.sftp.remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: selectedConn, path: entry.path }),
      })
      const json = await res.json()
      if (json.result?.ok) void listDir(sftpPath)
      else setSftpError(json.result?.error?.message ?? 'failed to remove')
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
      const res = await fetch('/api/ssh.sftp.rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: selectedConn, path: entry.path, toPath }),
      })
      const json = await res.json()
      if (json.result?.ok) void listDir(sftpPath)
      else setSftpError(json.result?.error?.message ?? 'failed to rename')
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
          disabled={connections.length === 0}
        >
          <option value="">{t('ssh.selectConnection')}</option>
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
        {ptyIdRef.current && (
          <button
            className={css.closeButton}
            onClick={() => {
              void fetch('/api/ssh.pty.close', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ptyId: ptyIdRef.current }),
              })
              termRef.current?.dispose()
              termRef.current = null
              ptyIdRef.current = null
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
