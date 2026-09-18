---
description: "Serve ctx.fs on a remote POSIX host over SFTP, with remote canonical paths, version-guarded edits, and atomic publication."
kind: "package-reference"
---

# @reachforstar/dsh-fs-sftp

English | [中文](README.zh.md)

## Summary

Use this package to point the harness filesystem at a remote POSIX host reachable over a saved `ctx.sshSftp` connection, keeping every file tool, workspace-file surface, and diff on that host. Remote paths are canonicalized through the remote shell, edits are version-guarded, and writes publish through a staged temp file plus an SFTP rename. Choose it when the remote host runs only OpenSSH; no remote Node or helper binary is required.

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

Mount this backend instead of `@deepseek-ai/dsh-fs-sandbox` or `@deepseek-ai/dsh-fs-local`, beside `@reachforstar/dsh-ssh` and a sandbox policy.

```yaml
- id: fs
  name: '@reachforstar/dsh-fs-sftp'
  config:
    connection: build-box
    cwd: /home/deploy/project
```

| Field | Default | Meaning |
|---|---|---|
| `connection` | required | Name or id of the saved `ctx.sshSftp` connection whose host holds the files. |
| `cwd` | required | Remote base directory for relative paths; absolute paths ignore it. |
| `diffBasisMaxBytes` | `10485760` | Exclusive byte limit on each overwrite-diff side; a larger or non-text previous content is reported as absent. |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for the accepted fields.

### When to choose it

Choose this backend when the files the agent must read and edit live on a remote POSIX host and that host has no Node runtime to install a helper into. Avoid it when the remote host is Windows (path canonicalization, no-clobber creation, and mode copy use the remote shell), when a same-millisecond same-size rewrite must be detected as a version change, or when large transfers must use the parallel SFTP path — `@deepseek-ai/dsh-fs-ssh` covers those.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

- **Path identity.** `resolve()` realpaths existing paths through the remote shell (`cd <path> && pwd -P`), and for missing paths realpaths the deepest existing ancestor and re-appends the missing suffix, so identity stays stable across creation. The reported path is trusted only when the SFTP world sees it too.
- **Versions.** A file version is the `mtime:size:mode` triple from the remote stat. Writes and edits can require `replaceIfVersion` (mismatch rejects with `FS_STALE_VERSION`) or `createIfAbsent` (an existing file rejects with `FS_NOT_OBSERVED`).
- **Atomic publication.** Mutations are serialized per target key, then stage a `.dsh-<name>.<uuid>.tmp` file in the target's directory and publish it with an SFTP rename. `createIfAbsent` publishes with an `ln` hard link so a concurrent creator wins, falling back to the rename only when the exec world cannot see the staged path.
- **Sandbox fence.** The per-call policy decides: `read-only` denies, `danger-full-access` permits, and `workspace-write` requires the canonical target under a `writableRoots()` entry; reads pass through. A removal contains the entry's parent instead of the entry, because the entry may be a symbolic link and removal takes the link itself.
- **Text mechanics.** Binary rejection (NUL in the first 8192 bytes), strict UTF-8 decoding, line-ending detection/restoration, and literal-replacement matching come from `@deepseek-ai/dsh-fs`'s shared text module, so the fs error taxonomy (`FS_NOT_TEXT`, `FS_EDIT_NOT_FOUND`, `FS_AMBIGUOUS_EDIT`) is identical to the local backend's.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH capability](../ssh/README.md) — the connection seam and saved definitions.
- [Local ssh2 provider](../ssh-local/README.md) — the transport beneath this backend.
- [Local filesystem backend](../../fs/fs-local/README.md) — the semantics this backend mirrors remotely.
- [SFTP subprocess provider](../subprocess-sftp/README.md) — commands and terminals over the same connection.
- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — shared operations and error meanings.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the filesystem consumers, which present remote paths and file contents while owning every tool and prompt.

#### KV Cache effect

This backend contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **POSIX remotes only**: canonicalization, no-clobber creation, and mode copy run through the remote shell (`cd`/`pwd -P`, `ln`, `chmod`); a Windows remote cannot honor them.
- **A same-millisecond rewrite of equal size and mode keeps its version**: the guard compares `mtime:size:mode`, so such a change is not reported as stale.
- **Whole-text reads load the file into host memory**: `readText` has no size cap; use `streamText`, `readByteRange`, or a consumer's own limit for large files.
- **One SFTP stream per transfer**: large uploads and downloads are sequential; the parallel `fastGet`/`fastPut` path exists only in `@deepseek-ai/dsh-fs-ssh`.
- **The exec and SFTP worlds must agree**: canonicalization and staged-path verification trust a path only when both views see it, so divergent test mounts degrade to the lexical display path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. The observable obligations are enforced by the SSH transport and consumed through `dsh-fs`; this backend adds no independently observed state relation.

</details>
