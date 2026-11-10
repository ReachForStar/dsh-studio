# Agent Note: Permanently deleting a Session

Status: implemented

English | [中文](2026-11-10-session-permanent-deletion.zh.md)

## Problem

Archiving hid a Session from grouping surfaces but kept its log. Users who wanted a conversation gone for good had no in-product action, and hand-removing `~/.dsh/sessions/` left the Workspace registry, the archive and pin sets, and the Client list pointing at an id that no longer existed. The destructive operation also needed a firm scope: a Session log is not a Workspace file and must never take a work tree or a directory down with it.

## Decision

Deletion is a persistence capability plus a registry cleanup, coordinated by one Workspace command.

- **The seam owns the artifact.** `SessionPersistence.delete(id, options?)` is the only destructive persistence operation. A backend removes the session's complete durable artifact set, including historical generations and session-local files, and resolves `false` when nothing exists so a retry after a crash is idempotent. It is abstract: a provider that cannot delete must not pretend otherwise.
- **A live writer wins.** The method rejects with `SessionAlreadyOwnedError` while this or another process holds a write handle. The JSONL backend takes the kernel write lease before removing the directory, so a concurrent writer cannot append into a directory being deleted; a created-but-unmaterialized Session also refuses, because its creator owns it.
- **The registry drops every reference.** `WorkspaceRegistry.deleteSession` first refuses a Session this process holds open (`WorkspaceLiveSessionError`) or one whose providers report running work (`WorkspaceActiveSessionError`, the archive admission waterfall). Only then does it call persistence, drop the header and path cache entries, detach the id from every Workspace record, and remove it from the archive and pin sets. An unknown id resolves `false` after the same idempotent cleanup.
- **Only the log is deleted.** Workspace files and work trees are never touched; the confirmation states that boundary, and the implementation has no filesystem access outside the persistence backend.
- **Two clicks, no stray destruction.** The Session row menu and archived rows offer permanent deletion. The dialog arms on the first click and deletes on the second; cancelling writes nothing. The Client refreshes the Host-authoritative Session list after success, so the row leaves every grouping surface in the same render generation.
- **The route reports its refusals.** `workspace/deleteSession` maps the two refusals to `workspace/session-open` and `workspace/session-active`; the dialog localizes both and shows the Host message for anything else.

## Alternatives considered

**Delete from the Client by removing a list row.** It would leave the log on disk and resurrect the Session at the next refresh; the operation exists because the data must go.

**Allow deleting an open Session.** The open tab and the routing session still hold live state, and the write handle would append into a removed directory. Refusing with a localized instruction keeps the destructive path honest; the user closes the Session first.

**Stop running work and delete in one call.** Archive needs that combination because it preserves the log for later unarchive. Deletion is permanent, so silently stopping work first would destroy more than the user asked to destroy; the caller must stop explicitly.

**Remove the log from the registry package.** Persistence owns the backend layout (project directories, format generations, locks); a second filesystem owner would duplicate that knowledge and break non-JSONL backends.

## Consequences

A deleted Session is absent from `stat`, `list`, and every Workspace surface, and its log directory is gone. The Host refuses while the Session is open or running, so the UI must offer the action on idle and archived rows and explain the refusal otherwise. Attachments, schedules, and jobs that referenced the Session are outside this decision and remain as they were; the Session list and registry simply no longer expose the id.
