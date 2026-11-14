/**
 * The seam's pure text mechanics, shared by every filesystem backend that
 * carries UTF-8 text: LF normalization (the canonical in-memory form and diff
 * basis), line-ending detection/restoration for write-back, literal-replacement
 * matching with the seam's edit error taxonomy, and strict decoding with
 * binary-sample rejection.
 * @module @deepseek-ai/dsh-fs/text
 */

import { applyHunks } from '@deepseek-ai/dsh-fs-patch'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
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

/** One tolerant match found in content, as a half-open range. */
interface TextMatch {
  readonly start: number
  readonly end: number
}

/** Every non-overlapping occurrence start of `needle`, in order. */
function indexesOf(content: string, needle: string): number[] {
  const indexes: number[] = []
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return indexes
    indexes.push(found)
    index = found + Math.max(needle.length, 1)
  }
}

/** Map curly quotes to their straight forms so pasted prose can match source. */
function normalizeQuotes(text: string): string {
  return text.replaceAll('“', '"').replaceAll('”', '"')
    .replaceAll('‘', "'").replaceAll('’', "'")
}

/** Strip the line-number prefixes an assistant may copy from a numbered read. */
function stripLineNumbers(text: string): string {
  return text.split('\n').map((line) => {
    const stripped = line.replace(/^\s*\d+\s*(?:[:→\t]|\|\s?)\s?/u, '')
    return stripped === line ? line : stripped
  }).join('\n')
}

/** Interpret the common C-style escapes a model may paste into `old_string`. */
function interpretEscapes(text: string): string {
  return text.replace(/\\(n|r|t|"|'|\\)/gu, (_match, escaped: string) => {
    switch (escaped) {
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      default: return escaped
    }
  })
}

/** One content line with its half-open range, excluding the newline. */
interface ContentLine {
  readonly start: number
  readonly end: number
  readonly text: string
}

function contentLines(content: string): ContentLine[] {
  const lines: ContentLine[] = []
  let start = 0
  for (const text of content.split('\n')) {
    lines.push({ start, end: start + text.length, text })
    start += text.length + 1
  }
  return lines
}

/** Line-window matches whose trimmed lines equal the search lines' trimmed forms. */
function indentFlexibleMatches(content: string, oldString: string): TextMatch[] {
  const search = oldString.split('\n')
  if (search.length === 0) return []
  const expected = search.map(line => line.trim())
  if (expected.every(line => line.length === 0)) return []
  const lines = contentLines(content)
  const matches: TextMatch[] = []
  for (let index = 0; index + search.length <= lines.length; index += 1) {
    const window = lines.slice(index, index + search.length)
    if (window.every((line, offset) => line.text.trim() === expected[offset])) {
      const first = window[0]
      const last = window.at(-1)
      if (first !== undefined && last !== undefined) matches.push({ start: first.start, end: last.end })
    }
  }
  return matches
}

/** How many lines of two equally sized windows carry the same trimmed text. */
function lineSimilarity(left: readonly string[], right: readonly string[]): number {
  const total = Math.max(left.length, right.length)
  if (total === 0) return 1
  let equal = 0
  for (let index = 0; index < total; index += 1) {
    if (left[index]?.trim() === right[index]?.trim()) equal += 1
  }
  return equal / total
}

/**
 * Block-anchor matches: the first and last non-empty search lines must match a
 * window's boundary lines and the remaining lines must agree at 0.8 or better.
 */
function anchorMatches(content: string, oldString: string): TextMatch[] {
  const search = oldString.split('\n')
  if (search.length < 3) return []
  const firstIndex = search.findIndex(line => line.trim().length > 0)
  const lastIndex = search.findLastIndex(line => line.trim().length > 0)
  if (firstIndex === lastIndex) return []
  const first = search[firstIndex]?.trim()
  const last = search[lastIndex]?.trim()
  if (first === undefined || last === undefined) return []
  const lines = contentLines(content)
  const matches: TextMatch[] = []
  for (let index = 0; index + search.length <= lines.length; index += 1) {
    const window = lines.slice(index, index + search.length)
    if (window[firstIndex]?.text.trim() !== first) continue
    if (window[lastIndex]?.text.trim() !== last) continue
    const similarity = lineSimilarity(search, window.map(line => line.text))
    if (similarity < 0.8) continue
    const start = window[0]
    const end = window.at(-1)
    if (start !== undefined && end !== undefined) matches.push({ start: start.start, end: end.end })
  }
  return matches
}

/**
 * Find literal occurrences from strict to tolerant stages, returning the first
 * stage that finds any. The order is exact text, quote normalization, copied
 * line-number prefixes, interpreted escapes, a trimmed search, indentation-
 * insensitive lines, and a first/last-line block anchor at 0.8 line similarity.
 * @param content - LF-normalized file content.
 * @param oldString - the model's search text, already LF-normalized.
 * @returns candidate ranges from one stage, in content order.
 */
function findLiteralMatches(content: string, oldString: string): TextMatch[] {
  const stages: TextMatch[][] = []
  const exact = indexesOf(content, oldString)
  stages.push(exact.map(start => ({ start, end: start + oldString.length })))
  const normalizedContent = normalizeQuotes(content)
  const normalizedSearch = normalizeQuotes(oldString)
  stages.push(indexesOf(normalizedContent, normalizedSearch)
    .map(start => ({ start, end: start + normalizedSearch.length })))
  const unnumbered = stripLineNumbers(oldString)
  stages.push(unnumbered === oldString ? [] : indexesOf(content, unnumbered)
    .map(start => ({ start, end: start + unnumbered.length })))
  const escaped = interpretEscapes(oldString)
  stages.push(escaped === oldString ? [] : indexesOf(content, escaped)
    .map(start => ({ start, end: start + escaped.length })))
  const trimmed = oldString.trim()
  stages.push(trimmed.length === 0 || trimmed === oldString ? [] : indexesOf(content, trimmed)
    .map(start => ({ start, end: start + trimmed.length })))
  stages.push(indentFlexibleMatches(content, oldString))
  stages.push(anchorMatches(content, oldString))
  return stages.find(stage => stage.length > 0) ?? []
}

/** One-based line number of an offset in content. */
function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}

/**
 * Describe ambiguous matches with line numbers so the model can narrow the
 * search instead of guessing which occurrence was meant.
 */
function ambiguousEditMessage(displayPath: string, content: string, matches: readonly TextMatch[]): string {
  const lines = matches.slice(0, 5).map(match => lineNumberAt(content, match.start)).join(', ')
  const more = matches.length > 5 ? ` and ${String(matches.length - 5)} more` : ''
  return `old_string matched ${String(matches.length)} times in "${displayPath}" near lines ${lines}${more}; provide a more specific old_string or set replace_all to true`
}

/**
 * Apply a literal replacement to LF-normalized content. Empty or missing search text throws
 * `FS_EDIT_NOT_FOUND`; multiple matches throw `FS_AMBIGUOUS_EDIT` unless `replaceAll` is true.
 * A search with no exact occurrence retries tolerant stages (quotes, copied line
 * numbers, escapes, trim, indentation, block anchor) and still reports ambiguity
 * instead of choosing one candidate.
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
  const matches = findLiteralMatches(content, oldNorm)
  if (matches.length === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && matches.length > 1) {
    throw new FsError(ambiguousEditMessage(displayPath, content, matches), 'FS_AMBIGUOUS_EDIT')
  }
  const selected = replaceAll ? matches : matches.slice(0, 1)
  let edited = content
  for (const match of [...selected].reverse()) {
    edited = `${edited.slice(0, match.start)}${newNorm}${edited.slice(match.end)}`
  }
  return { content: edited, replacements: selected.length }
}

function notTextError(verb: 'read' | 'edit', displayPath: string): FsError {
  return new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
}

/**
 * Apply parsed hunks to LF-normalized text, or report the seam's patch failure.
 *
 * Every backend that patches text shares this step, so an unmatched hunk
 * reports the same `FS_PATCH_MISMATCH` code and the same location as the others.
 * @param displayPath - the caller-facing path named in the failure.
 * @param before - the LF-normalized text to patch.
 * @param hunks - ordered hunks from `parsePatch`.
 * @returns the patched text.
 */
export function applyPatchOrThrow(displayPath: string, before: string, hunks: readonly PatchHunk[]): string {
  const result = applyHunks(before, hunks)
  if (!result.ok) {
    throw new FsError(
      `cannot patch "${displayPath}": hunk at patch line ${result.failure.hunkLineNumber} (${result.failure.stage}) does not match`,
      'FS_PATCH_MISMATCH',
    )
  }
  return result.after
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
