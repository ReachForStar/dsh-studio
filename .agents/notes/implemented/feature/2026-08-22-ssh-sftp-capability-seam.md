# Agent Note: SSH/SFTP capability seam

Status: implemented

English | [中文](2026-08-22-ssh-sftp-capability-seam.zh.md)

## Problem

The harness had no way for an agent (or a person in the Web GUI) to operate a remote server: no saved connection definitions, no remote command execution, and no file transfer. Bash, filesystem, and terminal capabilities all stop at the local execution world, so deploying against a remote host meant falling back to local `ssh` CLI orchestration with no managed state, no typed results, and no GUI surface.

## Decision

A new `remote/` package group ships the `ctx.ssh` capability seam in the standard three-role split:

- `@deepseek-ai/dsh-ssh` (Service Definition) owns a settings-backed connection-definition registry (`ssh` settings namespace: definitions plus a remembered host-key table), the live-connection contract, and the exec/SFTP vocabulary. It also owns the compose-able `test` probe and the write-only secret-update semantics (a save that omits a stored secret inherits it).
- `@deepseek-ai/dsh-ssh-local` (Service Provider) implements the seam over `ssh2`: one cached connection per definition id, promise-wrapped exec with bounded output and an owned timeout, and the SFTP operation surface. Host keys verify by default (`accept-new` remembers unknown keys, later changes are rejected; `reject` denies unknown keys; a definition may pin a `SHA256:<base64>` fingerprint). The handshake restricts to modern algorithms unless `allowLegacyAlgorithms` opts into ssh2 defaults for old servers. Large transfers use ssh2's parallel `fastGet`/`fastPut` above a configured threshold, passing the known size so ssh2 skips its fstat (1.17 delivers NAME arrays to fstat callbacks, which breaks `fastXfer`'s single-attrs assumption).
- `@deepseek-ai/dsh-tool-ssh` (Consumer) registers twelve model-facing tools: `ssh_connect`, `ssh_connections`, `ssh_disconnect`, `ssh_test`, `ssh_exec`, and the seven `sftp_*` transfer/browse tools.
- `@deepseek-ai/dsh-host-ssh-remotes` serves the Web GUI as a Typert Remote gateway (`ctx.sshGateway`, wire namespace `ssh`): list/save/remove definitions and the connectivity probe, all secret-free.
- `@deepseek-ai/dsh-client-ui-ssh` renders the Settings page over that gateway.

Composition: the base bundle mounts the provider and tools; the Web surface disables `tool-ssh` there and mounts it per agent through the standard preset, keeping the host-plane provider and gateway active for every session. The `ssh` settings namespace is registered by the Service Definition, so providers, tools, the gateway, and the GUI share one definition store.

## Security posture

Authentication secrets live in the harness settings document (shell-equivalent trust) and never cross a wire surface; the GUI and gateway treat them as write-only. Host-key verification closes the man-in-the-middle gap ssh2 leaves open by default; the modern algorithm default excludes CBC/arcfour ciphers, SHA-1 MACs, and `ssh-rsa` host-key signatures. POSIX private keys must not be group/other-readable.

## Alternatives considered

- **Thin wrapper around the local `ssh` CLI**: rejected — no typed results, no managed state, no in-process SFTP surface, and platform shell quirks (Windows) would leak into the seam.
- **Reusing the `credentials` seam for secrets**: deferred — the credential/authorization machinery targets env-referenced API keys; SSH definitions are one document with mixed secret and non-secret fields. The settings document carries them with documented shell-equivalent trust, and the credentials seam remains the future home.
- **One package for the whole family**: rejected — the roles evolve independently (a future remote provider or a TUI consumer would drag the GUI gateway and tools along); the shell trio is the template.
- **No host-key verification (TOFU-less)**: rejected — silent MITM acceptance is a security regression the seam should not ship; `accept-new` keeps first-contact ergonomics while catching later substitution.
- **Hand-rolled SFTP parallel transfer instead of `fastGet`/`fastPut`**: rejected — the built-in parallel path deletes real code; the `fileSize` option works around the fstat quirk.

## Consequences

The harness gains a complete remote-execution capability with typed results, durable definitions, host-key verification, and a GUI surface, matching the seam conventions of the rest of the product. Costs: secrets sit in the settings document in plaintext (documented), `ssh_exec` is foreground-only, the remote `cwd` prefix assumes a POSIX shell, and the local transfer paths are outside the `ctx.fs` policy world. Tests cover the seam through a real in-process `ssh2` server (password and public-key auth, exec, the full SFTP surface, host-key accept/reject/pin, algorithm default, and parallel transfers), plus a Loader-composition test and a real WSL sshd smoke.

## Testing

Unit and real-composition suites live per package under `packages/remote/*/tests`; the provider suite boots a real `ssh2` server with a minimal SFTP subsystem mapped onto a temp directory, and the tools suite drives the guarded executor through a Loader composition. The GUI package has store/component/host/invariant suites under `packages/client/ui-ssh/tests` (`test:gui`).
