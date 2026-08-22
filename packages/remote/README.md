# remote/ — SSH/SFTP capability family

English | [中文](README.zh.md)

The capability family spans the canonical SSH/SFTP seam, its local `ssh2` implementation, the model-facing tools, and the Web GUI connection-management surface. All are **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`ssh/`](ssh/README.md) | Defines the connection-definition registry contract (settings-backed), the live-connection handles, and the exec/SFTP vocabulary shared by Providers and Consumers. | `ctx.ssh` |
| [`ssh-local/`](ssh-local/README.md) | Implements the seam over `ssh2`: shared per-definition connections, host-key verification, secure algorithm defaults, and parallel-chunked large transfers. | (registers `ctx.ssh`) |
| [`tool-ssh/`](tool-ssh/README.md) | Exposes connection management, remote command execution, and SFTP transfer/browse tools to the model. | (registers on `ctx.tools`) |
| [`host/ssh-remotes`](../host/ssh-remotes/README.md) | Host Remote gateway for the browser: list/save/remove definitions and the connectivity probe. | `ctx.sshGateway` (wire namespace `ssh`) |
| [`client/ui-ssh`](../client/ui-ssh/README.md) | Web Settings page for managing saved connections. | (registers on `settings.section`) |

A leaf `cordis.yml` selects the local provider and the model-facing tools it needs. The base bundle mounts `ssh-local` + `tool-ssh`; the Web surface disables the tools there and mounts them per agent through the standard preset, keeping the host-plane provider and GUI gateway active for every session.

## Security posture

- Host keys verify by default (`accept-new`): an unknown key is remembered on first contact, a later change is rejected with `SSH_HOST_KEY_MISMATCH`, and a definition may pin an exact `SHA256:<base64>` fingerprint. `strictHostKey: reject` denies unknown keys outright.
- The handshake restricts to modern algorithms (no CBC/arcfour ciphers, no SHA-1 MACs, no `ssh-rsa` host-key signatures) unless `allowLegacyAlgorithms` opts into the ssh2 defaults for old servers.
- Authentication secrets live in the harness's `ssh` settings document (same trust as shell access) and never cross a wire surface; the GUI treats them as write-only.
- POSIX private keys must not be group/other-readable (`strictPrivateKeyPermissions`).
