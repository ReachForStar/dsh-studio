/**
 * ssh domain zod schemas (names derived from map keys).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { SftpEntryView, SshConnectionView, SshExecResult, SshPtyOpenResult } from './ssh.ts'

/** SshConnectionView row of ssh.list response. */
export const sshConnectionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number().int().positive(),
  user: z.string(),
  authKind: z.enum(['password', 'privateKey']),
}) satisfies z.ZodType<Wire<SshConnectionView>>

/** SftpEntryView row of ssh.sftp.* responses. */
export const sftpEntryViewSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.number().int().nonnegative(),
  mtime: z.number().int(),
}) satisfies z.ZodType<Wire<SftpEntryView>>

/** ssh.list request payload (empty object literal). */
export const sshListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'ssh.list'>>>

/** ssh.list response value. */
export const sshListValueSchema = z.object({
  connections: z.array(sshConnectionViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'ssh.list'>>>

/** ssh.pty.open request payload. */
export const sshPtyOpenRequestSchema = z.object({
  connectionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  cwd: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'ssh.pty.open'>>>

/** ssh.pty.open response value. */
export const sshPtyOpenValueSchema = z.object({
  ptyId: z.string(),
}) satisfies z.ZodType<Wire<SshPtyOpenResult>>

/** ssh.pty.write request payload. */
export const sshPtyWriteRequestSchema = z.object({
  ptyId: z.string(),
  data: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'ssh.pty.write'>>>

/** ssh.pty.resize request payload. */
export const sshPtyResizeRequestSchema = z.object({
  ptyId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
}) satisfies z.ZodType<Wire<RequestPayload<'ssh.pty.resize'>>>

/** ssh.pty.close request payload. */
export const sshPtyCloseRequestSchema = z.object({
  ptyId: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'ssh.pty.close'>>>

/** ssh.sftp.* shared request payload. */
const sshSftpRequestSchema = z.object({
  connectionId: z.string(),
  path: z.string(),
})

/** ssh.sftp.list request payload. */
export const sshSftpListRequestSchema = sshSftpRequestSchema satisfies z.ZodType<Wire<RequestPayload<'ssh.sftp.list'>>>

/** ssh.sftp.stat request payload. */
export const sshSftpStatRequestSchema = sshSftpRequestSchema satisfies z.ZodType<Wire<RequestPayload<'ssh.sftp.stat'>>>

/** ssh.sftp.mkdir request payload. */
export const sshSftpMkdirRequestSchema = sshSftpRequestSchema.extend({
  recursive: z.boolean().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'ssh.sftp.mkdir'>>>

/** ssh.sftp.remove request payload. */
export const sshSftpRemoveRequestSchema = sshSftpRequestSchema.extend({
  recursive: z.boolean().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'ssh.sftp.remove'>>>

/** ssh.sftp.rename request payload. */
export const sshSftpRenameRequestSchema = sshSftpRequestSchema.extend({
  toPath: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'ssh.sftp.rename'>>>

/** ssh.pty.write/resize response value. */
const sshPtyAcceptValueSchema = z.object({ accepted: z.literal(true) })

/** ssh.sftp.list response value. */
export const sshSftpListValueSchema = z.object({
  entries: z.array(sftpEntryViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'ssh.sftp.list'>>>

/** ssh.sftp.stat response value. */
export const sshSftpStatValueSchema = z.object({
  entry: sftpEntryViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'ssh.sftp.stat'>>>

/** ssh.sftp.mkdir response value. */
export const sshSftpMkdirValueSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'ssh.sftp.mkdir'>>>

/** ssh.sftp.remove response value. */
export const sshSftpRemoveValueSchema = z.object({
  removed: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'ssh.sftp.remove'>>>

/** ssh.sftp.rename response value. */
export const sshSftpRenameValueSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'ssh.sftp.rename'>>>

/** ssh.exec request payload. */
export const sshExecRequestSchema = z.object({
  connectionId: z.string(),
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'ssh.exec'>>>

/** ssh.exec response value. */
export const sshExecValueSchema = z.object({
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  aborted: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
}) satisfies z.ZodType<Wire<SshExecResult>>

/** ssh.pty.write response value. */
export const sshPtyWriteValueSchema = sshPtyAcceptValueSchema satisfies z.ZodType<Wire<ResponseValue<'ssh.pty.write'>>>

/** ssh.pty.resize response value. */
export const sshPtyResizeValueSchema = sshPtyAcceptValueSchema satisfies z.ZodType<Wire<ResponseValue<'ssh.pty.resize'>>>

/** ssh.pty.close response value. */
export const sshPtyCloseValueSchema = z.object({ closed: z.literal(true) }) satisfies z.ZodType<Wire<ResponseValue<'ssh.pty.close'>>>
