# @deepseek-ai/dsh-host-ssh-remotes

English | [中文](README.zh.md)

Host Remote gateway for the Web GUI's SSH connection-management surface: `list`/`save`/`delete` definitions and the `test` connectivity probe, all over the `ctx.ssh` seam. Secrets are write-only — every response is a secret-free view, and a save that omits a stored secret keeps the stored value.

The gateway registers its own Cordis service (`ctx.sshGateway`) whose wire namespace is `ssh`; the browser consumes it through `@deepseek-ai/dsh-api-remotes` as `ctx.remote.ssh.*`.

## Model Experience

None, as this package serves the browser only.

#### KV Cache effect

No direct effect; the browser calls it outside model requests.

## Known Limitations and Deferred Work

- **No list refresh push**: the browser refetches after each mutation; there is no forwarded event for external `settings.yaml` edits of the `ssh` section (a page reload converges).
