# @deepseek-ai/dsh-client-ui-ssh

English | [中文](README.zh.md)

SSH/SFTP connection-management page in Web Settings: list saved connections, create/edit/delete definitions, and probe connectivity. Secrets are write-only — password and passphrase inputs never echo a stored value back.

The page registers the `ssh` settings section (`order: 30`) and drives the `ssh` Remote gateway through a snapshot store (`SshConnectionsStore`); the host stays the single fact source.

## Model Experience

None, as this package is browser-only.

#### KV Cache effect

No direct effect; it never participates in model requests.

## Known Limitations and Deferred Work

- **No host-key display**: the editor does not show the remembered fingerprint of a host (the probe result and `SSH_HOST_KEY_MISMATCH` errors carry the fact).
- **No private-key permission surface**: `strictPrivateKeyPermissions` failures surface as connect errors.
