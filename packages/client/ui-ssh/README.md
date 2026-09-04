---
description: "Configure saved SSH connections in Web Settings and open the SSH/SFTP management page for password or private-key authentication."
kind: "package-reference"
---

# @reachforstar/dsh-client-ui-ssh

English | [中文](README.zh.md)

## Summary

Use this package to manage saved SSH connections from Web Settings. You can create, edit, remove, and test password or private-key definitions without exposing stored secrets. The package provides connection management; the full interactive PTY and SFTP conversation tab is provided by `@reachforstar/dsh-client-ui-polish`.

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

Mount this browser plugin when a Web profile needs a settings page for saved SSH connection definitions.

### When to choose it

Choose this package for connection-definition management and connectivity probes. Add `@reachforstar/dsh-client-ui-polish` when the same Web profile also needs the interactive PTY and SFTP conversation tab.

### Minimal configuration

```yaml
- id: ui-ssh
  name: '@reachforstar/dsh-client-ui-ssh'
```

The package has no required configuration fields. It requires the `ssh` Remote namespace supplied by the Web Remote assembly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin owns the settings section and a snapshot store. It delegates list, save, delete, and test operations to the generated `ssh` Remote namespace; the Host SSH gateway resolves stored definitions through `ctx.ssh` and returns secret-free views.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH capability](../../remote/ssh/README.md) — provider-independent connection and SFTP contract.
- [Local SSH provider](../../remote/ssh-local/README.md) — `ssh2` implementation used by the Web profile.
- [Host SSH Remote gateway](../../host/ssh-remotes/README.md) — browser-facing connection operations.
- [Web GUI polish](../ui-polish/README.md) — interactive PTY and SFTP conversation tab.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package only provides browser settings UI and does not register model-facing tools or prompt content.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The settings page manages connection definitions but does not replace the interactive terminal package.

- **No host-key display** — the editor does not show a remembered host fingerprint; probe results and connection errors carry the relevant outcome.
- **No private-key permission editor** — `strictPrivateKeyPermissions` failures appear as connection errors.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
