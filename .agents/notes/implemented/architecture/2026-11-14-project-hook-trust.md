# Agent Note: Project hook trust is a content-digest grant

Status: implemented

English | [中文](2026-11-14-project-hook-trust.zh.md)

## Problem

A Session working directory can carry a hook configuration that the bridge did not see when the process started. That file is project content: whoever can write the repository can name a shell command the bridge would run on every matching tool call. The process-level `configPath` is deployment content and can stay trusted, but a discovered project file needs an explicit person-level decision, and that decision must stop applying when the file changes.

## Decision

`dsh-hooks-claude-code` checks `<cwd>/<projectHooksPath>` (default `.claude/settings.json`) at each hook point. The file's exact bytes produce a SHA-256 digest; project groups run only while the mounted storage domain holds that digest for the project directory. `/hooks status` prints the digest and trust state, `/hooks trust` records the current digest, and `/hooks revoke` deletes the record. Without a storage domain project hooks never run, so absence fails closed instead of silently trusting repository content.

The digest covers raw bytes, not parsed groups: any edit — including a comment or whitespace — suspends the hooks until the new content is approved. Parsed configurations are cached by file path and `mtime`/`size` stamp, so an edit is observed on the next hook point rather than at the next process start. An untrusted project logs one warning per content version and continues without its hooks; the process configuration is unaffected.

## Alternatives considered

**Trust the parsed command set instead of the raw file.** Two different files could parse to the same commands, and a reviewer approving a structure would not see the bytes that later change. Byte hashing keeps the approval bound to what the person could inspect.

**Store trust in the settings document.** Project trust is per directory and must not be edited as free-form user configuration; the storage domain already provides a keyed record owned by this package, as the approval package does for project rules.

**Run project hooks in observe-only mode until trusted.** A hook that only logs is still executing repository content; skipping it entirely is the honest fail-closed state.

**Discover layered user and plugin configurations too.** Those layers have their own ownership and are not this change; only the project file is untrusted by construction.

## Consequences

A repository gains hook behavior only after an explicit `/hooks trust`, and reviewers can see the approved digest in `/hooks status`. Users who already run hooks through the process config see no change. The command needs a mounted storage domain; a deployment without one loses project hooks rather than gaining an implicit grant. Trust survives restarts with the storage medium but not edits, and revoking never requires the file to be present.

Verification: `packages/experimental/hooks-claude-code/tests/trust.spec.ts` covers untrusted skip with a warning, status/trust/revoke, a whitespace-only edit suspending trusted hooks, missing configuration, and the storage requirement.
