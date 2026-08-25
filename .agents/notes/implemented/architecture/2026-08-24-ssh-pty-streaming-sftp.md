# SSH PTY + Streaming SFTP

**Date:** 2026-08-24
**Packages:** `remote/ssh`, `remote/ssh-local`, `host/apiproxy`, `client/ui-polish`

## What changed

Extended the `ctx.ssh` capability seam with interactive PTY sessions and
streaming SFTP read/write. Added an apiproxy `ssh` domain (HTTP RPC + WebSocket
downlink) and a browser UI tab in `ui-polish` (xterm.js PTY + SFTP file
manager).

## Key decisions

- **PTY via ssh2 `client.shell`**: the `SshConnection.openPty` seam returns
  a `SshPtySession` (write/resize/onOutput/onExit/close). `ssh-local`
  implements it with ssh2's `shell()` channel; output is buffered so late
  subscribers replay history. `window-change` does not call `accept()`
  (ssh2 sends it with `want_reply=0`).

- **Streaming SFTP via `node:stream`**: `SshSftp.openRead`/`openWrite`
  return `Readable`/`Writable` streams backed by ssh2's
  `createReadStream`/`createWriteStream`. Files never land on the host
  local disk — bytes flow directly between the remote and the browser.

- **PTY output on the host frame stream**: `ssh/pty/output` (base64, ≤16 KiB)
  and `ssh/pty/exit` frames extend `HostFrame`. The apiproxy tracks live PTY
  sessions in a `Map<ptyId, SshPtySession>` and pushes frames to all open
  host frame queues.

- **SFTP download/upload as host-only routes**: download is a GET route
  (`/api/ssh/sftp/download`) that streams the remote file as an attachment;
  upload is a POST route (`/api/ssh/sftp/upload`) that pipes the request body
  into the SFTP write stream with backpressure. Neither uses the RPC
  envelope.

- **`ssh.exec` unary RPC**: a lightweight foreground command runner for
  probes (e.g. resolving `$HOME`). `resolveExec` fills defaults/caps, the
  apiproxy routes it through `ctx.ssh`; the result carries exitCode, stdout,
  stderr, and timeout/abort flags. SFTP initializes its directory from
  `echo $HOME` so the browser lands in the remote home instead of `/`.

- **SFTP remove is recursive for directories**: the `ssh.sftp.remove` payload
  accepts an optional `recursive` flag; the host drops it through to
  `sftp.remove`. The browser passes `recursive: true` for directory entries
  so a non-empty tree can be deleted.

- **Browser UI in `ui-polish`**: the SSH tab (order 30) uses xterm.js for the
  PTY terminal and a fetch-based SFTP file manager. The connection selector
  reads `ctx.remote.ssh.list()` via the `ssh.list` RPC. The SFTP manager is
  independent of the terminal: picking a connection lists its home
  immediately. When the terminal is open, a prompt tracker optionally follows
  the shell cwd (a "Follow terminal" switch); manual SFTP navigation pauses
  that follow.

## Testing

- `ssh-local`: in-memory pseudo-shell in `test-server.ts` handles
  pty/shell/window-change deterministically (no subprocesses). 52 tests,
  100% coverage.
- `apiproxy`: SSH domain stubs in test fixtures; 376 tests pass.
- `ui-polish`: tab registration test updated to include `ssh`.

## Known artifacts

- 3 unhandled `No response from server` errors from ssh2 SFTP
  `cleanupRequests` during test teardown. Exit code 0; CI does not fail.
