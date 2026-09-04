---
description: "Configure the Host Remote gateway for browser SSH/SFTP connection management, remote commands, PTY sessions, and file transfers."
kind: "package-reference"
---

# @reachforstar/dsh-host-ssh-remotes

English | [中文](README.zh.md)

## Summary

Use this package to expose SSH connection management, remote commands, interactive PTY sessions, and SFTP file transfers to the Web client. The gateway keeps connection secrets on the Host and returns secret-free connection views. It requires the `ctx.ssh` provider and Host Connection transport.

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

Mount the gateway in a Web Host composition together with an SSH provider, the Connection transport, and the client Remote assembly.

### When to choose it

Choose this package when a browser needs full SSH/SFTP operations over the authenticated Host API. Use `@reachforstar/dsh-client-ui-ssh` for connection settings and `@reachforstar/dsh-client-ui-polish` for the interactive conversation tab.

### Minimal configuration

```yaml
- id: ssh-remotes
  name: '@reachforstar/dsh-host-ssh-remotes'
```

The package has no standalone configuration fields. The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for accepted composition fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The gateway resolves each saved definition through `ctx.ssh`. JSON Remote methods handle commands, PTY control, and SFTP metadata; authenticated Fetch routes stream file content. PTY output and termination use the application Remote Event channel.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH capability](../../remote/ssh/README.md) — provider-independent connection and SFTP contract.
- [Local SSH provider](../../remote/ssh-local/README.md) — `ssh2` implementation.
- [Browser SSH settings](../../client/ui-ssh/README.md) — connection editor.
- [Web SSH/SFTP panel](../../client/ui-polish/README.md) — interactive terminal and file manager.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package serves the browser only.

#### KV Cache effect

No direct effect; the browser calls it outside model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No list refresh push**: the browser refetches after each mutation; external `settings.yaml` edits of the `ssh` section require a page reload.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
