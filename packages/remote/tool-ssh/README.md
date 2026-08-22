# @deepseek-ai/dsh-tool-ssh

English | [中文](README.zh.md)

Model-facing Consumer of the `ctx.ssh` capability seam. Tools:

- **Connection management**: `ssh_connect` (create or update a definition), `ssh_connections` (secret-free list), `ssh_disconnect`, `ssh_test`.
- **Remote execution**: `ssh_exec` (foreground command with bounded output and timeout).
- **SFTP**: `sftp_list`, `sftp_stat`, `sftp_read` (download), `sftp_write` (upload), `sftp_mkdir`, `sftp_rm`, `sftp_rename`.

Local transfer paths resolve against the caller's session workspace. Connections are shared per definition until `ssh_disconnect`; host keys verify by default and secrets never appear in results. `ssh_exec` presents as a terminal card; the rest render as generic cards.

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
