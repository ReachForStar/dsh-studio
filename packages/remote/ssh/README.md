---
description: "Use the provider-independent SSH capability to manage connection definitions, execute commands, and operate on remote SFTP files."
kind: "package-reference"
---

# @reachforstar/dsh-ssh

English | [中文](README.zh.md)

## Summary

Use this package as the provider-independent SSH capability for saved connection definitions, host-key records, remote commands, PTY sessions, and SFTP files. Choose a provider such as `@reachforstar/dsh-ssh-local` to supply the network implementation, then use `@reachforstar/dsh-tool-ssh` or the Web SSH panels as consumers.

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

Mount one SSH provider with this service definition when a composition needs saved connections or remote file and command capabilities.

### When to choose it

Choose this package when consumers need a stable SSH service independent of connection mechanics. Add `@reachforstar/dsh-ssh-local` for local `ssh2` connections, or provide another implementation of the service.

### Minimal configuration

```yaml
- id: ssh
  name: '@reachforstar/dsh-ssh-local'
```

The service definition itself has no configuration fields. Provider fields are documented by the selected provider's configuration catalog.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service owns durable connection definitions and remembered host keys. Providers implement connection establishment, command execution, PTY sessions, and SFTP operations behind the same `ctx.ssh` service.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Local SSH provider](../ssh-local/README.md) — local `ssh2` implementation.
- [SSH tools](../tool-ssh/README.md) — model-facing consumer.
- [Host SSH Remote gateway](../../host/ssh-remotes/README.md) — browser transport.
- [SSH Web panels](../../client/ui-polish/README.md) — browser consumers.

-----

Service Definition for the `ctx.ssh` capability seam: a settings-backed connection-definition registry plus the live-connection contract Providers implement. The registry (list/get/save/remove), the compose-able connectivity probe, the remembered host-key table, and the exec/SFTP vocabulary are provider-independent and owned here; Providers implement the connection mechanics.

## Service

Mount exactly one provider per context (a second registration throws, cordis' standard duplicate-service behavior). The service requires a settings provider: definitions and remembered host keys persist in the `ssh` settings namespace, which lives in the harness home document (`$DSH_HOME/settings.yaml` with `dsh-settings-file`) with the same trust as shell access.

```text
// registry (concrete)
ssh.list(): readonly SshConnectionDefinition[]
ssh.get(ref: SshConnectionId | string): SshConnectionDefinition | undefined
ssh.save(input: unknown): Promise<SshConnectionDefinition>   // id present = update, absent = create
ssh.remove(ref: SshConnectionId | string): Promise<boolean>
ssh.toView(definition): SshDefinitionView                    // secret-free wire view
ssh.resolve(ref): SshConnectionDefinition                    // id or unique name, throws SSH_NOT_FOUND
ssh.test(ref): Promise<SshTestResult>                        // open, probe, close; throws SSH_* on failure
ssh.knownHostFingerprint(hostPort: string): string | undefined
ssh.rememberHostKey(hostPort: string, fingerprint: string): Promise<void>

// connection contract (provider-owned)
ssh.connect(id): Promise<SshConnection>   // shared per definition id; close() evicts it
ssh.resolveExec(request): SshExecSpec     // provider defaults and caps
```

`SshConnection` offers `exec(spec)` (foreground command with bounded output and an owned timeout) and `sftp` (list/stat/readFile/writeFile/mkdir/remove/rename). Definitions carry an optional `hostKeyFingerprint` (`SHA256:<base64>`) that pins the server host key against man-in-the-middle substitution.

A save input's `id` selects update semantics: the connection must exist, and authentication secrets omitted by a write-only caller (a wire or tool payload that never saw the stored value) are inherited from the stored definition. Names are unique across the registry.

## Errors

Typed `SshError` with stable `code`s: `SSH_NOT_FOUND`, `SSH_NAME_EXISTS`, `SSH_INVALID_DEFINITION`, `SSH_CONNECT_FAILED`, `SSH_AUTH_FAILED`, `SSH_HOST_KEY_MISMATCH`, `SSH_HOST_KEY_UNKNOWN`, `SSH_CLOSED`, `SSH_EXEC_FAILED`, `SSH_SFTP_FAILED`, `SSH_LOCAL_IO`.

<a id="model-experience"></a>
## Model Experience

Indirectly, through @reachforstar/dsh-tool-ssh, which surfaces the seam's definitions, connections, exec results, and SFTP operations to the model.

#### KV Cache effect

No direct effect; the model-facing tools own any request tokens they emit.

## Known Limitations and Deferred Work

- **Definitions store authentication secrets in plaintext** in the harness settings document, matching shell-access trust; there is no OS-keyring integration yet (the `credentials` seam is the future home).
- **No private-key passphrase clearing from the GUI**: a write-only update can set but not clear a passphrase (edit `settings.yaml` to remove it).
- The `test` probe closes the shared connection it opens; a concurrent user of that definition reconnects on its next call.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
