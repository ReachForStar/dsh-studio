# Agent Note: Remote workspace providers over the fork SSH seam

Status: implemented

English | [中文](2026-09-18-remote-workspace-sftp-providers.zh.md)

## Problem

The fork needs the agent's filesystem and process execution world to be a remote POSIX host: the Web file panel, the Web terminal, and the model's file and shell tools must read, edit, and run against that host, while the harness itself keeps running locally. Saved `ctx.sshSftp` connections already carry authenticated SSH access through the settings-backed registry and the `ssh2` client, but the seam exposes only buffered `exec` and whole-file SFTP reads, and the upstream remote providers (`fs-ssh`, `subprocess-ssh`) require a deployed helper artifact plus a remote Node runtime on the other side.

## Decision

Two provider packages under `packages/remote/` implement the harness execution seams on one saved `ctx.sshSftp` connection:

- `@reachforstar/dsh-fs-sftp` registers `ctx.fs` (`SftpFileSystem`).
- `@reachforstar/dsh-subprocess-sftp` registers `ctx.subprocess` (`SftpSubprocessRuntime`).

The remote host needs only OpenSSH — its `sftp-server` subsystem and a POSIX login shell. Nothing is installed or uploaded there.

### Seam vocabulary added

`ssh` gains `SshConnection.openExec(request)`, a live full-duplex non-interactive channel whose stdout/stderr subscriptions replay early chunks, whose `write`/`endStdin` feed the command, and whose single `onExit` report settles the session; it carries no timeout because the caller owns termination through `close()` or the request's abort signal. `SshPtyOptions` accepts a `command` to run inside the PTY through the user's shell, and `SshSftp.openRead` accepts an inclusive `{start, end}` byte window.

### Filesystem semantics

- Path identity comes from the remote shell: `resolve()` realpaths an existing path with `cd <path> && pwd -P`, and for a missing path realpaths the deepest existing ancestor and re-appends the missing suffix.
- A file version is the remote stat's `mtime:size:mode`; writes and edits honor `replaceIfVersion` and `createIfAbsent` guards.
- Mutations serialize per target key, stage a `.dsh-<name>.<uuid>.tmp` file in the target directory, and publish with an SFTP rename; `createIfAbsent` publishes with `ln` so a concurrent creator wins.
- The per-call `ctx.sandboxPolicy` mode fences mutations over canonical remote path strings; reads pass through.
- Binary rejection, strict UTF-8 decoding, line-ending detection and restoration, and literal-replacement matching moved into `@deepseek-ai/dsh-fs`'s `text.ts`, so the fs error taxonomy is identical to `fs-local`'s.

### Subprocess semantics

- One spawn sends one shell command: `cd <cwd> 2>/dev/null || exit 126`, then the explicit environment layer through `env` (`-u` tombstones before assignments), then `exec <argv>`.
- Collected stdio reuses `subprocess-local`'s `OutputCollector`; spill files land in the Host temp directory. `stdio.control: 'pipe'` fails loud because an SSH exec channel carries only stdin, stdout, and stderr.
- A terminal allocates a PTY whose wrapper prints a token-stamped pid line before exec'ing the command; foreground inspection scans `/proc` (exact when `/proc/<pid>/syscall` is readable) and falls back to `ps -o tpgid=`.

### Local-provider fixes carried by this change

- `ssh-local`'s private-key permission probe maps a missing key file to `SSH_AUTH_FAILED` instead of leaking `ENOENT`.
- The POSIX remote-cwd suite boots its test server, which it previously assumed without starting.
- The in-process SSH test server spawns exec children with piped stdio and forwards channel data and EOF, so long-running commands and PTY wrappers stream both ways; the opt-in `detachedExec` gives each exec child its own process group for the foreground-signalling tests.

## Alternatives considered

**Reuse the upstream helper-backed providers.** Rejected because `fs-ssh` and `subprocess-ssh` require an installed helper and a remote Node runtime, and they connect through the upstream `ctx.ssh` connection owner rather than the fork's settings-backed `ctx.sshSftp` registry.

**Extend the buffered `exec` for processes.** Rejected because it captures output and resolves only at exit, so streaming stdin/stdout/stderr, collected reads, and long-running handles cannot be represented.

**Run one-shot commands through the PTY channel.** Rejected because a PTY merges stderr into the terminal stream and adds echo and line-discipline semantics that collected and piped stdio must not inherit.

**Upload a helper script on connect.** Rejected because the goal is a remote that needs only OpenSSH; the PTY wrapper's printed pid line removes the remote staging file the first design needed.

**Duplicate the text mechanics inside `fs-sftp`.** Rejected because the binary, UTF-8, line-ending, and edit-matching rules and their error codes must not drift between the local and remote backends.

**Parameterize `fs-local`/`subprocess-local` with a transport.** Rejected because each seam provider is bound to one execution world; separate packages keep the local backends and their coverage untouched.

## Consequences

- Any OpenSSH host becomes a workspace. Windows remotes are unsupported because canonicalization, no-clobber creation, mode copy, and the terminal wrapper use the remote POSIX shell.
- The version identity `mtime:size:mode` is weaker than a content hash: a same-millisecond rewrite of equal size and mode keeps its version.
- The subprocess provider has no control channel and no remote process-group sweep when the connection drops; termination closes the session, so detached remote processes can outlive the handle.
- Both providers share one connection handle from the fork registry and never close it, because other consumers may hold it; provider disposal terminates and awaits every live process and terminal.
- Swapping providers is a profile row override (`fs-sandbox` → `fs-sftp`, `subprocess` → `subprocess-sftp`, plus `sandbox-policy.workspaceRoot`), so the Web file panel, the Web terminal, and the model tools move to the remote workspace without code changes.
- The seam vocabulary grew, and `docs/subsystems/ssh-sftp.md` documents the new session, command, and read-window members.

## Testing

- `fs-sftp` and `subprocess-sftp` carry 42 focused tests against the in-process `ssh2` test server (SFTP mapped onto a temp root, exec through a real POSIX shell); the `ssh-local`, `fs`, and `fs-local` suites pass in the same run.
- These suites are POSIX-bound and listed in `vitest.config.ts`'s Windows-unsupported set, so the Linux CI lanes hold their coverage.
- A comparison against the pre-change `ssh-local` files reproduced the two defects the fixes address (the `ENOENT` leak and the unstarted cwd suite); the ssh2 `No response from server` cleanup noise appears in both runs and is pre-existing.
- Manual: the `web-lab` profile mounts both providers on the saved `wsl` connection against a WSL Ubuntu checkout, and the Web file panel and Web terminal then operate on that remote workspace.
