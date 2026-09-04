# Agent Note: SSH PTY and streaming SFTP

Status: implemented

English | [中文](2026-08-24-ssh-pty-streaming-sftp.zh.md)

## Problem

The SSH capability needs interactive PTY sessions and streamed SFTP transfers for the Web panel without exposing credentials or creating a second transport protocol.

## Decision

`ctx.ssh` provides `openPty`, `openRead`, and `openWrite` through the canonical SSH capability. The local provider implements PTY with `ssh2` shell channels and SFTP with `ssh2` streams; PTY output is buffered for late subscribers and window changes do not request a server reply.

The Host SSH gateway exposes generated `ssh` Remote methods for command execution, PTY lifecycle, and SFTP metadata. PTY output and exit use the shared Remote Event channel. Authenticated Fetch routes stream SFTP downloads and uploads, so transfer bytes do not pass through an RPC envelope or a host temporary file.

The browser SSH panel uses the generated Remote namespace and Fetch routes. It buffers initial PTY output until the terminal is attached and keeps SFTP navigation independent from the terminal session.

## Alternatives considered

**Restore the standalone apiproxy protocol.** Rejected because the application already provides generated Remote, Remote Event, and authenticated Fetch transports; a second WebSocket protocol would duplicate authentication and lifecycle handling.

**Buffer complete files on the Host.** Rejected because streamed SFTP preserves backpressure and avoids unnecessary local copies of remote data.

**Expose only connection management.** Rejected because the Web requirement includes interactive PTY and SFTP operations, not only saved definitions and connectivity probes.

## Consequences

The Web profile provides full SSH command, PTY, and SFTP behavior through one transport architecture. PTY sessions require explicit cleanup, and real-server compatibility remains dependent on SSH authentication, host-key policy, and server SFTP behavior. The generated SSH Remote and event catalogs remain the source for browser method and event names.

## Testing

The SSH gateway, Remote Event forwarding, Fetch route registration, local provider, and browser adapter have focused tests. A real SSH server is still required to validate authentication, host-key changes, PTY behavior, and SFTP interoperability outside the test fixtures.
