---
description: "Serve ctx.subprocess on a remote POSIX host over SSH exec and PTY channels, with collected or piped stdio, terminals, and foreground signalling."
kind: "package-reference"
---

# @reachforstar/dsh-subprocess-sftp

English | [中文](README.zh.md)

## Summary

Use this package to run commands and interactive terminals on a remote POSIX host through a saved `ctx.sshSftp` connection, so shell tools, terminals, and language servers see the same remote files as the SFTP filesystem backend. The remote host needs only OpenSSH: commands stream over exec channels, PTY sessions discover their pid from a wrapper line, and termination drives the same session. Choose it when no remote Node runtime or helper binary can be installed.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider instead of `@deepseek-ai/dsh-subprocess-local`, beside `@reachforstar/dsh-ssh` and the SFTP filesystem backend that shares the connection.

```yaml
- id: subprocess
  name: '@reachforstar/dsh-subprocess-sftp'
  config:
    connection: build-box
```

| Field | Default | Meaning |
|---|---|---|
| `connection` | required | Name or id of the saved `ctx.sshSftp` connection commands and terminals run on. |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for the accepted fields.

### When to choose it

Choose this provider when the execution world is a remote POSIX host reached over OpenSSH without a deployed helper, and when the Bash, terminal, LSP, and ptc-runtime consumers should operate on the same remote files as the filesystem backend. Avoid it when a request needs a separate duplex control channel (`stdio.control: 'pipe'` is rejected), when foreground-group inspection must be exact on a remote without Linux `/proc` or `ps`, or when the remote host is Windows. `@deepseek-ai/dsh-subprocess-ssh` covers the helper-backed case.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

- **One shared connection.** Every process and terminal opens over the connection resolved from `ctx.sshSftp`; the provider never closes it, because other consumers may hold the same handle. Disposal aborts the provider lifetime, then terminates and awaits every live process and terminal.
- **Command construction.** A spawn sends one shell command: `cd <cwd> 2>/dev/null || exit 126`, then the explicit environment layer through the `env` utility (`-u NAME` tombstones before assignments, so an outer `PATH` unset cannot break the exec), then `exec <argv>`. Argument and path quoting is single-quote based.
- **Stdio.** `stdin` accepts a fixed payload or a pipe; `stdout`/`stderr` accept `pipe`, `inherit`, or a bounded collection whose spill file is written on the Host's temp directory. A caller-initiated terminate resolves with a null exit code and signal instead of failing.
- **Executable lookup.** `resolveExecutable()` probes absolute paths with `[ -x … ]`, rejects relative paths containing `/`, and resolves bare names through `command -v` with an optional `PATH` override; a miss raises `SubprocessExecutableNotFoundError`.
- **Terminals.** The PTY wrapper prints a token-stamped line carrying its pid before `exec`ing the command; the provider reads that line (5s budget) to learn the session pid, then inspects the foreground group by scanning `/proc` (exact when `/proc/<pid>/syscall` is readable) or falling back to `ps -o tpgid=`. `signalForeground()` maps the seam's five signals to POSIX numbers and signals the group.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subprocess subsystem](../../../docs/subsystems/subprocess.md) — spawn, collection, terminal, and lifetime APIs.
- [SSH capability](../ssh/README.md) — the connection seam and saved definitions.
- [Local ssh2 provider](../ssh-local/README.md) — the transport beneath this provider.
- [SFTP filesystem backend](../fs-sftp/README.md) — the same-connection filesystem provider.
- [Local subprocess provider](../../subprocess/subprocess-local/README.md) — the semantics this provider mirrors remotely.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Bash, terminal, LSP, and ptc-runtime consumers, which own command semantics, output limits, and execution deadlines.

#### KV Cache effect

This provider contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No control channel**: an SSH exec channel carries only stdin/stdout/stderr, so `stdio.control: 'pipe'` fails loud instead of silently dropping fd 3 traffic.
- **Foreground inspection depends on the remote tooling**: exact `inputWaiting` needs a readable `/proc/<pid>/syscall`; elsewhere it degrades to a `tpgid` poll, and `signalForeground()` throws when no group can be resolved.
- **Termination closes the session**: the remote command is killed by closing its channel, so processes it detached can outlive the handle and a dropped connection leaves remote cleanup unconfirmed.
- **Collected-output spill files live on the Host**, not the remote, and are not removed by provider disposal.
- **POSIX shell required**: the `cd` prefix, environment layer, and terminal wrapper assume a POSIX shell; a failed `cd` exits 126.
- **Environment names are validated** as shell identifiers, and terminals fail allocation if the wrapper cannot publish its pid within 5 seconds.
- **A dropped connection fails in-flight handles**; no work is replayed automatically.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. The observable obligations are enforced by the SSH transport and consumed through `dsh-subprocess`; this provider adds no independently observed state relation.

</details>
