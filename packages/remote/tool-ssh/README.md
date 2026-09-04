---
description: "Give an agent SSH connection, command, and SFTP tools over the configured SSH capability."
kind: "package-reference"
---

# @reachforstar/dsh-tool-ssh

English | [中文](README.zh.md)

## Summary

Use this package to give an agent tools for saving and testing SSH connections, running bounded remote commands, and reading or writing remote SFTP files. The tools keep SSH secrets on the Host and use the configured `ctx.ssh` provider. Choose it when model-driven remote operations are required and destructive actions need explicit command-level handling.

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

Mount this tool consumer in an agent preset beside an SSH capability provider.

### When to choose it

Choose this package when an agent must connect to named SSH servers, execute foreground commands, or transfer files through SFTP. Use the Web SSH panels when a human needs an interactive terminal instead.

### Minimal configuration

```yaml
- id: tool-ssh
  name: '@reachforstar/dsh-tool-ssh'
```

The package has no required configuration fields; the generated [tool catalog](../../../docs/tool-catalog.md#reachforstardsh-tool-ssh) owns the exact model-visible schemas.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool consumer resolves the caller's SSH service, validates connection references through the service registry, and delegates command and SFTP operations to live connection handles. Local file paths for transfer tools are resolved by the tool consumer and do not alter the SSH service definition.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH capability](../ssh/README.md) — provider-independent service contract.
- [Local SSH provider](../ssh-local/README.md) — `ssh2` implementation.
- [Host SSH Remote gateway](../../host/ssh-remotes/README.md) — browser transport.
- [Generated tool catalog](../../../docs/tool-catalog.md#reachforstardsh-tool-ssh) — exact schemas.

-----

Model-facing Consumer of the `ctx.ssh` capability seam. Tools:

- **Connection management**: `ssh_connect` (create or update a definition), `ssh_connections` (secret-free list), `ssh_disconnect`, `ssh_test`.
- **Remote execution**: `ssh_exec` (foreground command with bounded output and timeout).
- **SFTP**: `sftp_list`, `sftp_stat`, `sftp_read` (download), `sftp_write` (upload), `sftp_mkdir`, `sftp_rm`, `sftp_rename`.

Local transfer paths resolve against the caller's session workspace. Connections are shared per definition until `ssh_disconnect`; host keys verify by default and secrets never appear in results. `ssh_exec` presents as a terminal card; the rest render as generic cards.

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

The twelve tool schemas (names, required/optional parameters, and descriptions) are registered into `ctx.tools` and join prompt assembly like every other tool; see the generated [tool catalog](../../../docs/tool-catalog.md) for the exact schema. The `tool:ssh` prompt section (`order: 106`) adds one line of cross-call guidance:

##### Verbatim text for this field, when needed

```markdown
SSH/SFTP tools operate on saved connections: `ssh_connect` persists a definition before `ssh_exec`/`sftp_*` can use it, and connections stay open until `ssh_disconnect`. Verify remote commands before running destructive ones.
```

#### Token effect

Each tool call contributes its JSON arguments to the request; no fixed context block is added.

#### KV Cache effect

The prompt section text is stable across calls, so it does not invalidate a reusable prefix; tool schemas are fixed per deployment.

## Known Limitations and Deferred Work

- **No background remote execution**: `ssh_exec` is foreground-only (no `run_in_background`); long operations must fit the provider timeout.
- **`sftp_write` does not create remote parent directories**; use `sftp_mkdir` with `recursive` first.
- **Local transfer files are not sandboxed**: `sftp_read`/`sftp_write` read and write local paths directly, outside the `ctx.fs` policy world.
- **Host keys are verified but not exposed to the model**: a fingerprint change surfaces as `SSH_HOST_KEY_MISMATCH`; clearing it means editing the settings document.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
