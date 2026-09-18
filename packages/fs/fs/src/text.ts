/**
 * The seam's pure text mechanics, shared by every filesystem backend that
 * carries UTF-8 text: LF normalization (the canonical in-memory form and diff
 * basis), line-ending detection/restoration for write-back, literal-replacement
 * matching with the seam's edit error taxonomy, and strict decoding with
 * binary-sample rejection.
 * @module @deepseek-ai/dsh-fs/text
 */

import { FsError } from './types.ts'

/** First bytes sampled for the binary (NUL-byte) rejection. */
export const BINARY_SAMPLE_BYTES = 8192

/** Line ending style detected before LF normalization. */
export type LineEndings = 'LF' | 'CRLF'

/**
 * Collapse CRLF to LF — the canonical in-memory form every edit/diff basis
 * uses. Lone `\r` bytes (not followed by `\n`) are left untouched.
 * @param content - decoded text in whatever line-ending style the file had.
 * @returns the text with every `\r\n` pair replaced by `\n`.
 */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/**
 * Detect the dominant line-ending style from the file head.
 * @param raw - decoded text.
 * @returns `CRLF` when CRLF pairs outnumber lone LFs in the sample, else `LF`.
 */
export function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * Convert LF-normalized content back to the line-ending style detected at read
 * time, for write-back. `LF` returns the content unchanged; `CRLF` re-normalizes
 * first so an already-CRLF sequence is never doubled to `\r\r\n`.
 * @param content - the LF-normalized (edited) text.
 * @param lineEndings - the original file's style, as detected by {@link detectLineEndings}.
 * @returns the text in the original file's line-ending style.
 */
export function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Apply a literal replacement to LF-normalized content. Empty or missing search text throws
 * `FS_EDIT_NOT_FOUND`; multiple matches throw `FS_AMBIGUOUS_EDIT` unless `replaceAll` is true.
 * @param content - the current file content, already LF-normalized.
 * @param oldString - literal text to find; CRLF inside it is normalized to LF before
 *   matching.
 * @param newString - literal replacement text, normalized the same way.
 * @param replaceAll - replace every match instead of requiring exactly one.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the edited LF-normalized content plus how many occurrences were replaced.
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

function notTextError(verb: 'read' | 'edit', displayPath: string): FsError {
  return new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
}

/**
 * Strictly decode one UTF-8 buffer, translating invalid bytes into the seam's
 * `FS_NOT_TEXT` error.
 * @param buffer - the bytes to decode.
 * @param verb - the operation named in the failure.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the decoded text.
 */
export function decodeUtf8(buffer: Uint8Array, verb: 'read' | 'edit', displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes; any other throw is an unreachable runtime fault. */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

/**
 * One strict streaming UTF-8 decoder. The global `TextDecoder` and Node's
 * `util` export are separate type declarations of the same runtime class; the
 * factory pins the parameter type so callers on either side pass through.
 * @returns a strict (`fatal`) UTF-8 decoder that owns cross-chunk state.
 */
export function createUtf8StreamDecoder(): TextDecoder {
  return new TextDecoder('utf-8', { fatal: true })
}

/**
 * Decode a stream chunk under a strict streaming decoder.
 * @param decoder - the streaming decoder that owns cross-chunk state.
 * @param chunk - the chunk to decode, or `undefined` to flush.
 * @param verb - the operation named in the failure.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the decoded text of the chunk.
 */
export function decodeUtf8Stream(
  decoder: TextDecoder,
  chunk: Uint8Array | undefined,
  verb: 'read' | 'edit',
  displayPath: string,
): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode()
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes; any other throw is an unreachable runtime fault. */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

/**
 * Whether a buffer carries a NUL byte within its first {@link BINARY_SAMPLE_BYTES}
 * bytes — the binary rejection a text read applies.
 * @param buffer - the file content (or its leading window).
 * @returns true when the sampled prefix contains a NUL byte.
 */
export function isBinarySample(buffer: Uint8Array): boolean {
  return buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)
}
