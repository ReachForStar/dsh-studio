---
kind: upgrade-guide
description: "Session persistence backends must implement the new abstract delete method, and Workspace consumers gain a permanent Session deletion command."
---

# Session persistence gains permanent deletion

English | [中文](guide.zh.md)

## Change

`SessionPersistence` now declares `delete(id, options?)` as an abstract method. A backend that extends the class stops compiling until it implements the method. The method permanently removes one stored session's complete durable artifact set, resolves `false` for an id that no longer exists, and rejects with `SessionAlreadyOwnedError` while this or another process holds a write handle. It never touches workspace files or work trees.

The Workspace Remote namespace gains `deleteSession({ sessionId })`, which answers `{ deleted: boolean }` after removing the stored log and dropping the session from workspace accounting, the archive set, and the pin set. It refuses an open session as `workspace/session-open` and running work as `workspace/session-active`. The right-Sidebar Session menu and archived rows offer the action; no existing call changes.

## Migration

1. In every out-of-tree package that extends `SessionPersistence`, implement `delete(id, options?)`. Remove the session's complete artifact set for `id`, return `false` when no artifact exists, and throw `SessionAlreadyOwnedError` while a write handle owns the session. Do not modify caller-owned state such as workspace records or archive sets.
2. Run the shared contract suite from `@deepseek-ai/dsh-session-persistence` (the `runPersistenceContract` export) with your backend factory; the new delete cases must pass alongside the existing ones.
3. If you implement a persistence provider, verify that a deleted session is absent from `stat` and `list`, that a repeated `delete` resolves `false`, and that an open write handle makes `delete` reject.
4. Publish a new version of that package; consumers accept the seam only when every provider implements the full abstract surface.
