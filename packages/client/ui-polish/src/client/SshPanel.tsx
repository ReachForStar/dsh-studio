/**
 * SSH/SFTP panel: a conversation.view tab providing an interactive PTY
 * terminal (xterm.js) and a streaming SFTP file manager.
 *
 * The connection selector lists stored SSH connections. The PTY and SFTP
 * operate on the selected connection. PTY output arrives on the host
 * WebSocket frame stream (`/api/events.host`); SFTP file transfer uses the
 * host-only download channel (GET) and a carrier POST upload route.
 *
 * The SFTP file manager is an independent, always-usable browser: selecting a
 * connection loads its directory immediately. When the terminal is open, a
 * prompt tracker optionally follows the shell cwd so `cd` in the terminal
 * switches the SFTP view — but manual SFTP navigation pauses that follow to
 * avoid yanking the view back.
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

/** One PTY frame projected off the WebSocket `server-request` payload. */
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
  signal?: AbortSignal,
): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }> {
  const rpcId = crypto.randomUUID()
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    ...(signal !== undefined ? { signal } : {}),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`[SshPanel] RPC ${method} failed: ${res.status}`, text)
    return { ok: false, error: { message: `${res.status}: ${text}` } }
  }
  const body = (await res.json()) as {
    result?: { ok: true; value: unknown } | { ok: false; error: { message: string } }
  }
  const result = body.result
  if (result === undefined) {
    console.error(`[SshPanel] RPC ${method} malformed response:`, body)
    return { ok: false, error: { message: 'malformed response' } }
  }
  if (result.ok) return { ok: true, value: result.value }
  console.error(`[SshPanel] RPC ${method} error:`, result.error.message)
  return { ok: false, error: result.error }
}

/** Join a directory and a child name into an absolute remote path. */
function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** Parent of an absolute path ('/' stays '/'). */
function parentOf(path: string): string {
  if (path === '/' || path === '') return '/'
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

/** Resolve the remote home directory by running `echo $HOME`. Returns null on failure. */
async function resolveHomeDir(connectionId: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const result = await rpc('ssh.exec', { connectionId, command: 'echo $HOME' }, signal)
    if (!result.ok) return null
    const value = result.value as { exitCode?: number | null; stdout?: string } | undefined
    if (value === undefined || value.exitCode !== 0) return null
    const home = (value.stdout ?? '').trim()
    return home.startsWith('/') ? home : null
  } catch (error) {
    if (signal?.aborted) return null
    console.error('[SshPanel] resolveHomeDir failed:', error)
    return null
  }
}

/**
 * Subscribe to the host WebSocket stream for PTY output/exit frames.
 *
 * The carrier serves `/api/events.host` as a WebSocket downlink (asking a
 * plain GET returns 426 Upgrade Required). Each inbound message is a
 * `server-request` envelope `{ type, rpcId, method, payload }` where `payload`
 * is the HostFrame. This driver parses the envelope and forwards only
 * `ssh/pty/*` frames; unsubscribe closes the socket.
 */
function subscribeHostFrames(
  onFrame: (frame: HostFrameLike) => void,
  onDrop: (ptyId: string) => void,
): () => void {
  const url = new URL('/api/events.host', window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url.toString())
  socket.addEventListener('open', () => {
    console.debug('[SshPanel] host frames WebSocket opened')
  })
  socket.addEventListener('error', () => {
    console.error('[SshPanel] host frames WebSocket error')
  })
  const handleMessage = (event: MessageEvent): void => {
    try {
      if (typeof event.data !== 'string') return
      const full = JSON.parse(event.data) as { payload?: HostFrameLike }
      const frame = full.payload
      if (frame === undefined) return
      if (frame.type === 'ssh/pty/output' && frame.ptyId && frame.data) {
        onFrame(frame)
      } else if (frame.type === 'ssh/pty/exit' && frame.ptyId) {
        onDrop(frame.ptyId)
      }
    } catch (error) {
      console.error('[SshPanel] malformed host frame:', error)
    }
  }
  socket.addEventListener('message', handleMessage)
  return () => {
    socket.removeEventListener('message', handleMessage)
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close()
    }
  }
}

/** Strip ANSI escape sequences (colors, cursor moves, etc.) from terminal output. */
function stripAnsi(text: string): string {
  let result = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  result = result.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
  result = result.replace(/\x1b./g, '')
  return result
}

/**
 * Extract the working directory from the last shell prompt in a chunk of
 * terminal output. Handles common PS1 formats:
 *   - [user@host ~]#            (RHEL/CentOS, bracketed)
 *   - user@host:cwd$ / user@host:cwd# (bash \u@\h:\w\$)
 *   - cwd$                      (minimal prompt)
 *   - ~/path$                   (tilde-relative, expanded with `homeDir`)
 * `homeDir` is the remote home used to expand `~`; it is passed by the caller
 * (from `ssh.exec echo $HOME`) so a non-root user resolves to its real home.
 * Returns the absolute path or null when no prompt is found.
 */
function extractCwdFromPrompt(raw: string, homeDir: string): string | null {
  const clean = stripAnsi(raw).replace(/\r/g, '')
  const lines = clean.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trimEnd()
    if (line === '') continue
    // RHEL/CentOS bracketed prompt: [user@host dir]#
    const bracket = line.match(/^\[((?:[\w.-]+@[\w.-]+)?\s*)([^\]]+)\]\s*[$#]\s*$/)
    // bash \u@\h:\w\$ and minimal dir$ prompts.
    const plain = line.match(/^(?:[\w.-]+@[\w.-]+:)?(\S+)\s*[$#]\s*$/)
    let cwd: string | null = null
    if (bracket !== null) cwd = (bracket[2] ?? '').trim()
    else if (plain !== null) cwd = (plain[1] ?? '').trim()
    if (cwd === null || cwd === '') continue
    if (cwd === '~' || cwd === '~/') cwd = homeDir
    else if (cwd.startsWith('~/')) cwd = homeDir + cwd.slice(1)
    if (!cwd.startsWith('/')) continue
    return cwd
  }
  return null
}

/** Streaming prompt tracker: accumulates PTY output and reports cwd changes. */
function createPromptTracker(onCwd: (cwd: string) => void, homeDir: string): { feed: (chunk: string) => void; reset: () => void } {
  let buffer = ''
  let lastCwd: string | null = null
  return {
    feed(chunk: string) {
      buffer += chunk
      if (buffer.length > 8192) buffer = buffer.slice(-8192)
      const cwd = extractCwdFromPrompt(buffer, homeDir)
      if (cwd !== null && cwd !== lastCwd) {
        lastCwd = cwd
        onCwd(cwd)
      }
    },
    reset() {
      buffer = ''
      lastCwd = null
    },
  }
}

/** Marker sequence emitted by the cwd probe command. */
const CWD_PROBE_START = '__DSH_CWD_START__'
const CWD_PROBE_END = '__DSH_CWD_END__'

/**
 * Parse the cwd out of a probe response. The probe writes a command that
 * prints `<start>$(pwd)<end>`; this parser extracts the path between the
 * markers regardless of the surrounding terminal output (echoed command,
 * prompt, etc.).
 */
function extractCwdFromProbe(chunk: string): string | null {
  const start = chunk.indexOf(CWD_PROBE_START)
  if (start === -1) return null
  const afterStart = start + CWD_PROBE_START.length
  const end = chunk.indexOf(CWD_PROBE_END, afterStart)
  if (end === -1) return null
  const cwd = chunk.slice(afterStart, end).trim()
  return cwd.startsWith('/') ? cwd : null
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
  const [ptyOpen, setPtyOpen] = useState(false)
  const [ptyStarting, setPtyStarting] = useState(false)
  const [followCwd, setFollowCwd] = useState(true)
  const [homeDir, setHomeDir] = useState('/root')
  const [downloading, setDownloading] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [busyAction, setBusyAction] = useState<number | null>(null)
  const [connectionsLoaded, setConnectionsLoaded] = useState(false)

  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const resizeObserver = useRef<ResizeObserver | null>(null)
  const hostUnsubRef = useRef<(() => void) | null>(null)
  const followCwdRef = useRef(followCwd)
  followCwdRef.current = followCwd
  const promptTrackerRef = useRef<{ feed: (chunk: string) => void; reset: () => void } | null>(null)
  const cwdProbeRef = useRef<{ buffer: string; onResult: (cwd: string | null) => void } | null>(null)
  const ptyWriteRef = useRef<((text: string) => void) | null>(null)
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

  // Subscribe to host WebSocket frames for PTY output/exit.
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
        const text = new TextDecoder().decode(bytesArr)
        // Feed the prompt tracker so the SFTP path can follow terminal cd.
        promptTrackerRef.current?.feed(text)
        // Feed any in-flight cwd probe so it can parse the marker response.
        const probe = cwdProbeRef.current
        if (probe !== null) {
          probe.buffer += text
          const cwd = extractCwdFromProbe(probe.buffer)
          if (cwd !== null) {
            probe.onResult(cwd)
            cwdProbeRef.current = null
          }
        }
      },
      (ptyId) => {
        if (ptyId !== ptyIdRef.current) return
        ptyIdRef.current = null
        promptTrackerRef.current = null
        setPtyOpen(false)
        resizeObserver.current?.disconnect()
        resizeObserver.current = null
        termRef.current?.dispose()
        termRef.current = null
      },
    )
    hostUnsubRef.current = unsub
    return () => { unsub(); hostUnsubRef.current = null }
  }, [])

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
        const msg = result.error?.message ?? 'failed to list directory'
        console.error('[SshPanel] sftp list failed:', path, msg)
        setSftpError(msg)
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[SshPanel] sftp list exception:', path, msg)
      setSftpError(msg)
    } finally {
      setSftpLoading(false)
    }
  }, [selectedConn])

  // Latest listDir for the cwd probe callback (avoids stale selectedConn).
  const listDirRef = useRef(listDir)
  listDirRef.current = listDir

  /**
   * Write a cwd-probe command to the PTY and resolve the current working
   * directory from a marked response. Falls back to prompt parsing when the
   * probe times out or the terminal is not open.
   */
  const probeCwd = useCallback((onDone?: (cwd: string | null) => void) => {
    const ptyId = ptyIdRef.current
    if (ptyId === null) {
      onDone?.(null)
      return
    }
    const write = ptyWriteRef.current
    if (write === null) {
      onDone?.(null)
      return
    }
    cwdProbeRef.current = {
      buffer: '',
      onResult: (cwd) => {
        if (cwd === null) {
          onDone?.(null)
          return
        }
        if (followCwdRef.current) {
          const current = sftpPathRef.current
          if (cwd !== current) {
            setSftpPath(cwd)
            void listDirRef.current(cwd)
          }
        }
        onDone?.(cwd)
      },
    }
    // The probe survives in the PTY history; reset it on the next open.
    const cmd = `printf '\\n${CWD_PROBE_START}'; pwd; printf '${CWD_PROBE_END}\\n'`
    write(`${cmd}\r`)
    // Fall back to prompt parsing if the probe does not answer quickly.
    window.setTimeout(() => {
      if (cwdProbeRef.current?.buffer.includes(CWD_PROBE_END)) return
      cwdProbeRef.current = null
      onDone?.(null)
    }, 1500)
  }, [])

  // Load the selected connection's directory as soon as it is picked, so the
  // SFTP browser is usable without opening the terminal. Prefer the remote
  // home directory; fall back to '/' when the probe fails.
  useEffect(() => {
    if (selectedConn === null) return
    const ac = new AbortController()
    setSftpEntries([])
    setSftpError(null)
    void (async () => {
      const home = await resolveHomeDir(selectedConn, ac.signal)
      if (ac.signal.aborted) return
      if (home !== null) setHomeDir(home)
      const initial = home ?? '/'
      setSftpPath(initial)
      void listDir(initial)
    })()
    return () => { ac.abort() }
  }, [selectedConn, listDir])

  // Open a PTY session on the selected connection. The xterm view is
  // mounted by a separate effect once `terminalEl` + `ptyOpen` are ready.
  const openPty = useCallback(async () => {
    if (!selectedConn) return
    setPtyError(null)
    setPtyStarting(true)
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
      promptTrackerRef.current?.reset()
      setPtyOpen(true)
    } catch (error) {
      setPtyError(error instanceof Error ? error.message : String(error))
    } finally {
      setPtyStarting(false)
    }
  }, [selectedConn])

  // Mount xterm once the PTY is open and the terminal container is ready.
  useEffect(() => {
    if (!ptyOpen || terminalEl === null || termRef.current !== null) return
    const ptyId = ptyIdRef.current
    if (ptyId === null) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
      fontSize: 14,
      theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc' },
      convertEol: false,
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
    // Programmatic PTY write for the cwd probe (user keystrokes go via onData).
    ptyWriteRef.current = (text: string) => {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)))
      void rpc('ssh.pty.write', { ptyId, data: b64 })
    }

    // Fit + resize only when the container actually changes size, avoiding
    // the runaway feedback of a fixed-interval fit loop.
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        fit.fit()
        void rpc('ssh.pty.resize', { ptyId, cols: term.cols, rows: term.rows })
      })
      observer.observe(terminalEl)
      resizeObserver.current = observer
    }

    term.focus()

    // Seed a prompt tracker that follows the terminal working directory,
    // but only when the user keeps the follow switch on.
    promptTrackerRef.current = createPromptTracker((cwd) => {
      if (!followCwdRef.current) return
      const current = sftpPathRef.current
      if (cwd === current) return
      setSftpPath(cwd)
      void listDir(cwd)
    }, homeDir)

    // Wait for the shell to settle, then probe the exact cwd so the SFTP view
    // lands where the terminal actually is (prompt parsing is best-effort).
    const initialProbe = window.setTimeout(() => { probeCwd() }, 600)

    return () => {
      window.clearTimeout(initialProbe)
      resizeObserver.current?.disconnect()
      resizeObserver.current = null
      term.dispose()
      termRef.current = null
      promptTrackerRef.current = null
      ptyWriteRef.current = null
      cwdProbeRef.current = null
    }
  }, [ptyOpen, terminalEl, listDir, homeDir, probeCwd])

  // Clean up the PTY on unmount.
  useEffect(() => {
    return () => {
      resizeObserver.current?.disconnect()
      resizeObserver.current = null
      if (ptyIdRef.current) {
        void rpc('ssh.pty.close', { ptyId: ptyIdRef.current }).catch(() => undefined)
      }
      termRef.current?.dispose()
      termRef.current = null
      ptyIdRef.current = null
    }
  }, [])

  // SFTP: navigate into a directory (manual navigation pauses cwd follow).
  const navigateDir = useCallback((entry: SftpEntryView) => {
    if (entry.type !== 'directory') return
    setFollowCwd(false)
    void listDir(entry.path)
  }, [listDir])

  // SFTP: go to parent directory (manual navigation pauses cwd follow).
  const goParent = useCallback(() => {
    setFollowCwd(false)
    void listDir(parentOf(sftpPath))
  }, [sftpPath, listDir])

  // SFTP: download a file via the host-only GET channel.
  const downloadFile = useCallback(async (entry: SftpEntryView) => {
    if (!selectedConn) return
    setDownloading(entry.name)
    try {
      const url = `/api/ssh/sftp/download?connectionId=${encodeURIComponent(selectedConn)}&path=${encodeURIComponent(entry.path)}`
      const response = await fetch(url)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`下载失败 (${response.status}): ${text}`)
      }
      const blob = await response.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = entry.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(a.href)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      setSftpError(msg)
      console.error('[SshPanel] sftp download failed:', entry.path, msg)
    } finally {
      setDownloading(null)
    }
  }, [selectedConn])

  // SFTP: upload via file input (carrier POST, raw file body).
  const handleUploadClick = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (file === undefined || !selectedConn) return
      setUploading(true)
      setSftpError(null)
      const targetPath = joinPath(sftpPath, file.name)
      try {
        const response = await fetch(
          `/api/ssh/sftp/upload?connectionId=${encodeURIComponent(selectedConn)}&path=${encodeURIComponent(targetPath)}`,
          { method: 'POST', body: file },
        )
        if (!response.ok) {
          const text = await response.text()
          throw new Error(`上传失败 (${response.status}): ${text}`)
        }
        void listDir(sftpPath)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        setSftpError(msg)
        console.error('[SshPanel] sftp upload failed:', targetPath, msg)
      } finally {
        setUploading(false)
      }
    }
    input.click()
  }, [selectedConn, sftpPath, listDir])

  // SFTP: mkdir.
  const handleMkdir = useCallback(() => {
    const name = window.prompt(t('ssh.mkdirPrompt'))
    if (name === null || name.trim() === '') return
    const path = joinPath(sftpPath, name.trim())
    void (async () => {
      setSftpError(null)
      try {
        const result = await rpc('ssh.sftp.mkdir', { connectionId: selectedConn, path })
        if (result.ok) { void listDir(sftpPath) }
        else { setSftpError(result.error?.message ?? '创建目录失败') }
      } catch (error) {
        setSftpError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [selectedConn, sftpPath, listDir, t])

  // SFTP: remove (recursive for directories).
  const removeEntry = useCallback(async (entry: SftpEntryView) => {
    if (!selectedConn) return
    setBusyAction(nextActionId())
    setSftpError(null)
    const recursive = entry.type === 'directory'
    try {
      const result = await rpc('ssh.sftp.remove', {
        connectionId: selectedConn, path: entry.path, recursive,
      })
      if (result.ok) { void listDir(sftpPath) }
      else { setSftpError(result.error?.message ?? `删除失败: ${entry.name}`) }
    } catch (error) {
      setSftpError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyAction(null)
    }
  }, [selectedConn, sftpPath, listDir])

  // SFTP: rename.
  const renameEntry = useCallback(async (entry: SftpEntryView) => {
    if (!selectedConn) return
    const newName = window.prompt(t('ssh.renamePrompt'), entry.name)
    if (newName === null || newName === entry.name || newName.trim() === '') return
    const toPath = joinPath(parentOf(entry.path), newName.trim())
    setSftpError(null)
    try {
      const result = await rpc('ssh.sftp.rename', {
        connectionId: selectedConn, path: entry.path, toPath,
      })
      if (result.ok) { void listDir(sftpPath) }
      else { setSftpError(result.error?.message ?? `重命名失败: ${entry.name}`) }
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
          onChange={(e) => { setSelectedConn(e.target.value || null) }}
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
          <button className={css.button} disabled={ptyStarting} onClick={() => void openPty()}>
            {ptyStarting ? t('ssh.opening') : t('ssh.openTerminal')}
          </button>
        )}
      </div>

      {ptyError && <div className={css.error}>{ptyError}</div>}

      {/* PTY terminal — always mounted so xterm gets a measurable size. */}
      <div className={css.terminal}>
        <div ref={(el) => { if (el) setTerminalEl(el) }} className={css.terminalInner} />
        {ptyOpen && termRef.current && (
          <button
            className={css.closeButton}
            onClick={() => {
              const id = ptyIdRef.current
              if (id) void rpc('ssh.pty.close', { ptyId: id }).catch(() => undefined)
              ptyIdRef.current = null
              setPtyOpen(false)
              resizeObserver.current?.disconnect()
              resizeObserver.current = null
              termRef.current?.dispose()
              termRef.current = null
              promptTrackerRef.current = null
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
            <button
              className={`${css.button}${followCwd ? ` ${css.active}` : ''}`}
              disabled={!selectedConn || !ptyOpen}
              title={t('ssh.followCwd')}
              onClick={() => {
                const next = !followCwd
                setFollowCwd(next)
                if (next) probeCwd()
              }}
            >
              {t('ssh.followCwd')}
            </button>
            <button
              className={css.button}
              disabled={!selectedConn || sftpLoading}
              onClick={() => { setFollowCwd(false); void listDir(sftpPath) }}
            >
              {t('ssh.refresh')}
            </button>
            <button className={css.button} disabled={!selectedConn} onClick={handleMkdir}>
              {t('ssh.mkdir')}
            </button>
            <button className={css.button} disabled={!selectedConn || uploading} onClick={handleUploadClick}>
              {uploading ? t('ssh.uploading') : t('ssh.upload')}
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
                <tr key={entry.path} onClick={() => { navigateDir(entry) }} className={entry.type === 'directory' ? css.dirRow : undefined}>
                  <td>{entry.name}</td>
                  <td>{entry.type}</td>
                  <td>{entry.type === 'file' ? formatSize(entry.size) : '—'}</td>
                  <td>{new Date(entry.mtime).toLocaleString()}</td>
                  <td className={css.rowActions} onClick={(e) => { e.stopPropagation() }}>
                    {entry.type === 'file' && (
                      <button className={css.actionBtn} disabled={downloading === entry.name} onClick={() => { void downloadFile(entry) }}>
                        {downloading === entry.name ? t('ssh.downloading') : t('ssh.download')}
                      </button>
                    )}
                    <button className={css.actionBtn} disabled={busyAction !== null} onClick={() => { void renameEntry(entry) }}>
                      {t('ssh.rename')}
                    </button>
                    <button className={css.actionBtn} disabled={busyAction !== null} onClick={() => { void removeEntry(entry) }}>
                      {t('ssh.remove')}
                    </button>
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

// Monotonic counter for per-row busy state labels (no React state identity needs).
let actionCounter = 0
function nextActionId(): number {
  actionCounter += 1
  return actionCounter
}

/** Format a byte count for display. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
