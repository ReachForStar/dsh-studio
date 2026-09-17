# Agent Note: A closed terminal releases the SSH connection

Status: implemented

English | [中文](2026-09-17-terminal-releases-ssh-connection.zh.md)

## Problem

Closing the SSH terminal in the Web panel left the SSH connection open. The gateway's `ptyClose` closed the terminal channel only, while `ctx.sshSftp.connect(id)` hands out one handle per definition that stays pooled until an explicit close or provider teardown — and the gateway had no method that closed a connection. A connection opened for a terminal therefore outlived it forever, holding a live SSH session and its channels for the rest of the process.

## Decision

The gateway records the shared connection each PTY was opened on. Closing the last terminal that holds a connection closes it too; a shell that exits on its own releases the connection the same way. The release compares handles by identity, which is what the provider's pooled `connect` returns, and a close the provider had already performed is idempotent. Later exec and SFTP operations reconnect on demand, because a closed handle drops out of the provider's pool. A connection close that fails is logged rather than reported to the caller: the terminal is already gone and the close is not something the caller can retry.

## Alternatives considered

**Add a `disconnect` Remote method and let the panel call it.** The panel would have to know when a connection is no longer needed, duplicating the terminal lifecycle on the client, while the host already knows when its last terminal is gone.

**Close the connection on every terminal close.** Two terminals on one definition would have the second one's connection closed underneath it.

**Leave the pooled connection in place.** An idle connection outlives the terminal that created it, and the panel offers no way to end it.

## Consequences

SFTP and exec pay one SSH handshake after the terminals are closed, on the next operation that needs the definition. A transfer in flight when the last terminal closes is interrupted, because the handle it holds is closed; retrying it reconnects. The gateway covers the last-holder close, retention while another terminal holds the connection, release on a remote exit, on-demand reconnect, and a failing close in its own tests.
