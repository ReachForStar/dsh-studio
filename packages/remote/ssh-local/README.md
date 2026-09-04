---
description: "Configure the local ssh2 provider for bounded SSH commands, interactive PTY sessions, and SFTP transfers."
kind: "package-reference"
---

# @reachforstar/dsh-ssh-local

English | [中文](README.zh.md)

## Summary

Use this package to provide the `ctx.ssh` capability through the local `ssh2` client. It reuses connections per definition, supports bounded command execution, interactive PTY sessions, host-key verification, and SFTP transfers. Choose it for a Host process that can reach the target SSH servers directly.

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

Mount this provider beside `@reachforstar/dsh-ssh` when the Host process owns the SSH network connection.

### When to choose it

Choose this provider for direct SSH/SFTP access from Node. Set `allowLegacyAlgorithms: true` only when a required server does not support the secure default algorithm set.

### Minimal configuration

```yaml
- id: ssh
  name: '@reachforstar/dsh-ssh-local'
```

The provider's optional fields are documented in the configuration section below and the generated [configuration catalog](../../../docs/config-catalog.md).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider keeps one live connection per saved definition and evicts it after a drop. Command output is bounded per stream, PTY sessions expose output and exit callbacks, and SFTP transfers select sequential or parallel paths according to the configured size threshold.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH capability](../ssh/README.md) — provider-independent service definition.
- [SSH tools](../tool-ssh/README.md) — model-facing consumer.
- [Host SSH Remote gateway](../../host/ssh-remotes/README.md) — browser transport.

-----

Local Service Provider of the `ctx.ssh` seam over [`ssh2`](https://www.npmjs.com/package/ssh2). One connection per definition id is cached and reused until closed or dropped; exec and SFTP operations are promise-wrapped with bounded output and an owned timeout that kills the remote command.

## Config

```yaml
- id: ssh
  name: '@reachforstar/dsh-ssh-local'
  config:
    defaultExecTimeoutMs: 60000       # default foreground command timeout
    maxExecTimeoutMs: 600000          # cap for per-call overrides
    outputMaxBytes: 65536             # per-stream capture cap; overflow keeps the tail
    strictHostKey: accept-new         # accept-new | reject
    allowLegacyAlgorithms: false      # true = ssh2 defaults (old servers)
    keepaliveIntervalMs: 0            # SSH keep-alive interval (0 disables)
    strictPrivateKeyPermissions: true # reject group/other-readable POSIX keys
    fastTransferThresholdBytes: 1048576  # transfers above this use parallel fastGet/fastPut (0 disables)
```

## Behavior

- **Host-key verification**: with `accept-new` (default) an unknown key is remembered in the `ssh` settings namespace on first contact and later changes are rejected; `reject` denies unknown keys outright. A definition's `hostKeyFingerprint` pin wins over the remembered table. Denials surface as `SSH_HOST_KEY_MISMATCH` / `SSH_HOST_KEY_UNKNOWN`.
- **Modern algorithm default**: the handshake restricts to curve25519/nistp ECDH kex, GCM/CTR ciphers, SHA-2 MACs, and ed25519/ecdsa/rsa-sha2 host keys. Legacy servers need `allowLegacyAlgorithms: true`.
- **Bounded exec**: per-stream output caps keep the tail (truncation flagged); the owned deadline kills the remote command via signal and reports `timedOut`; caller cancellation reports `aborted`.
- **Parallel large transfers**: files above `fastTransferThresholdBytes` transfer through ssh2's `fastGet`/`fastPut` (concurrent chunked reads/writes); smaller files stream sequentially with precise overwrite semantics. The fast download passes the known size so ssh2 skips its fstat (which 1.17 delivers as a NAME array, breaking its single-attrs assumption).
- **Shared connections**: `connect` returns the cached handle; a dropped server connection evicts itself and the next `connect` opens a fresh one. Composition teardown closes every pooled connection.

<a id="model-experience"></a>
## Model Experience

Indirectly, through @reachforstar/dsh-tool-ssh, which surfaces the seam's connections, exec results, and SFTP operations to the model.

#### KV Cache effect

No direct effect; the model-facing tools own any request tokens they emit.

## Known Limitations and Deferred Work

- **`ssh_exec`'s `cwd` prefix assumes a POSIX remote shell** (single-quoted `cd`); a Windows cmd remote host cannot honor it.
- **No host-key rotation UX yet**: a changed key fails with `SSH_HOST_KEY_MISMATCH`; clearing the remembered entry currently means editing the `ssh` settings section.
- **No background remote commands**: `ssh_exec` is foreground-only; long operations must fit the timeout.
- **No known_hosts file interop**: the remembered table lives in settings, not `~/.ssh/known_hosts`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
