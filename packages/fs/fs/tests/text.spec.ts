/** The seam's pure text mechanics: line endings, tolerant literal edits, patches, and strict decoding. */
import { describe, expect, it } from 'vitest'
import { parsePatch } from '@deepseek-ai/dsh-fs-patch'
import {
  applyLiteralEdit,
  applyPatchOrThrow,
  BINARY_SAMPLE_BYTES,
  createUtf8StreamDecoder,
  decodeUtf8,
  decodeUtf8Stream,
  detectLineEndings,
  isBinarySample,
  normalizeLineEndings,
  restoreLineEndings,
} from '../src/text.ts'
import { FsError } from '../src/types.ts'

const encoder = new TextEncoder()

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof FsError) return error.code
    throw error
  }
  throw new Error('expected an FsError')
}

describe('line endings', () => {
  it('normalizes CRLF pairs and leaves lone CR bytes alone', () => {
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc')
    expect(normalizeLineEndings('a\rb')).toBe('a\rb')
  })

  it('detects the dominant style from the head', () => {
    expect(detectLineEndings('a\r\nb\r\nc\r\n')).toBe('CRLF')
    expect(detectLineEndings('a\nb\r\nc\n')).toBe('LF')
    expect(detectLineEndings('single line')).toBe('LF')
  })

  it('restores the recorded style without doubling CRLF', () => {
    expect(restoreLineEndings('a\nb', 'LF')).toBe('a\nb')
    expect(restoreLineEndings('a\nb', 'CRLF')).toBe('a\r\nb')
    expect(restoreLineEndings('a\r\nb', 'CRLF')).toBe('a\r\nb')
  })
})

describe('literal edits', () => {
  it('replaces one exact occurrence and reports the count', () => {
    expect(applyLiteralEdit('one two three', 'two', 'TWO', false, 'file.txt'))
      .toEqual({ content: 'one TWO three', replacements: 1 })
  })

  it('normalizes CRLF in both search and replacement', () => {
    expect(applyLiteralEdit('a\nb\nc', 'a\r\nb', 'x\ny', false, 'file.txt'))
      .toEqual({ content: 'x\ny\nc', replacements: 1 })
  })

  it('rejects an empty or missing search with FS_EDIT_NOT_FOUND', () => {
    expect(codeOf(() => applyLiteralEdit('abc', '', 'x', false, 'f'))).toBe('FS_EDIT_NOT_FOUND')
    expect(codeOf(() => applyLiteralEdit('abc', 'zzz', 'x', false, 'f'))).toBe('FS_EDIT_NOT_FOUND')
  })

  it('refuses an ambiguous match and names the candidate lines', () => {
    const content = 'a\nneedle\nb\nneedle\nc'
    expect(() => applyLiteralEdit(content, 'needle', 'x', false, 'f.txt'))
      .toThrow(/matched 2 times in "f.txt" near lines 2, 4; provide a more specific old_string or set replace_all to true/u)
    expect(codeOf(() => applyLiteralEdit(content, 'needle', 'x', false, 'f.txt'))).toBe('FS_AMBIGUOUS_EDIT')
    const many = Array.from({ length: 7 }, () => 'needle').join('\n')
    expect(() => applyLiteralEdit(many, 'needle', 'x', false, 'f.txt')).toThrow(/and 2 more/u)
  })

  it('replaces every match under replace_all', () => {
    const result = applyLiteralEdit('x\ny\nx\n', 'x', 'z', true, 'f')
    expect(result).toEqual({ content: 'z\ny\nz\n', replacements: 2 })
  })

  it('matches through curly quotes', () => {
    expect(applyLiteralEdit('say “hello” now', 'say "hello" now', 'greeted', false, 'f').content)
      .toBe('greeted')
  })

  it('matches through copied line-number prefixes', () => {
    const content = 'alpha\nbeta\ngamma'
    expect(applyLiteralEdit(content, '1: alpha\n2: beta', 'alpha\nbeta!', false, 'f').content)
      .toBe('alpha\nbeta!\ngamma')
  })

  it('matches through pasted escapes', () => {
    expect(applyLiteralEdit('a\tb', 'a\\tb', 'c', false, 'f').content).toBe('c')
    expect(applyLiteralEdit('a\nb', 'a\\nb', 'c', false, 'f').content).toBe('c')
    expect(applyLiteralEdit('a\rb', 'a\\rb', 'c', false, 'f').content).toBe('c')
    expect(applyLiteralEdit('say "x"', 'say \\"x\\"', 'said', false, 'f').content).toBe('said')
  })

  it('matches a trimmed search when the surrounding text differs', () => {
    expect(applyLiteralEdit('  needle here\n', '\nneedle here\n', 'found', false, 'f').content).toBe('  found\n')
  })

  it('matches indentation-insensitive lines', () => {
    expect(applyLiteralEdit('    one\n        two\nrest', 'one\ntwo', 'merged', false, 'f').content)
      .toBe('merged\nrest')
  })

  it('matches a block anchor whose inner lines are mostly similar', () => {
    const content = 'function a() {\n  return 1\n  // note\n  // keep\n}\n'
    expect(applyLiteralEdit(content, 'function a() {\n  return 2\n  // note\n  // keep\n}', 'replaced', false, 'f').content)
      .toBe('replaced\n')
  })

  it('requires matching first and last anchor lines and a similar middle', () => {
    const content = 'function a() {\n  return 1\n  // note\n}\n'
    // A different opening line is not a block anchor.
    expect(codeOf(() => applyLiteralEdit(content, 'function b() {\n  return 1\n  // note\n}', 'x', false, 'f')))
      .toBe('FS_EDIT_NOT_FOUND')
    // The same opening and closing line with unrelated middle lines stays below the similarity bar.
    expect(codeOf(() => applyLiteralEdit(content, 'function a() {\n  unrelated A\n  unrelated B\n}', 'x', false, 'f')))
      .toBe('FS_EDIT_NOT_FOUND')
    // A window whose closing line differs is skipped before similarity is measured.
    expect(codeOf(() => applyLiteralEdit('lead\n  return 1\n  // note\nother\n', 'lead\n  return 1\n  // note\n}', 'x', false, 'f')))
      .toBe('FS_EDIT_NOT_FOUND')
  })

  it('ignores anchors shorter than three lines and searches without any non-empty line', () => {
    const content = 'only\n'
    expect(codeOf(() => applyLiteralEdit(content, 'only\nx', 'y', false, 'f'))).toBe('FS_EDIT_NOT_FOUND')
    expect(codeOf(() => applyLiteralEdit(content, '   ', 'y', false, 'f'))).toBe('FS_EDIT_NOT_FOUND')
  })

  it('reports tolerant-stage ambiguity instead of choosing one candidate', () => {
    const content = '“a”\n“a”\n'
    expect(codeOf(() => applyLiteralEdit(content, '"a"', 'x', false, 'f'))).toBe('FS_AMBIGUOUS_EDIT')
  })
})

describe('patches', () => {
  it('applies parsed hunks and reports the seam failure code for a mismatch', () => {
    const [operation] = parsePatch('*** Begin Patch\n*** Update File: f\n@@\n-a\n+b\n*** End Patch\n')
    if (operation?.kind !== 'update') throw new Error('expected one parsed update operation')
    expect(applyPatchOrThrow('f', 'a\n', operation.hunks)).toBe('b\n')
    expect(() => applyPatchOrThrow('f.txt', 'zzz\n', operation.hunks)).toThrow(/cannot patch "f.txt": hunk at patch line \d+/u)
    expect(codeOf(() => applyPatchOrThrow('f.txt', 'zzz\n', operation.hunks))).toBe('FS_PATCH_MISMATCH')
  })
})

describe('strict decoding', () => {
  it('decodes valid UTF-8 and names the verb when the bytes are not text', () => {
    expect(decodeUtf8(encoder.encode('héllo'), 'read', 'f')).toBe('héllo')
    const invalid = Uint8Array.from([0xff, 0xfe])
    expect(codeOf(() => decodeUtf8(invalid, 'read', 'f.bin'))).toBe('FS_NOT_TEXT')
    expect(() => decodeUtf8(invalid, 'edit', 'f.bin')).toThrow('cannot edit "f.bin": invalid UTF-8 text')
  })

  it('decodes a split multi-byte character across chunks and flushes', () => {
    const decoder = createUtf8StreamDecoder()
    const bytes = encoder.encode('éllo')
    expect(decodeUtf8Stream(decoder, bytes.subarray(0, 1), 'read', 'f')).toBe('')
    expect(decodeUtf8Stream(decoder, bytes.subarray(1), 'read', 'f')).toBe('éllo')
    expect(decodeUtf8Stream(decoder, undefined, 'read', 'f')).toBe('')
  })

  it('reports invalid stream bytes with the seam code', () => {
    const decoder = createUtf8StreamDecoder()
    expect(codeOf(() => decodeUtf8Stream(decoder, Uint8Array.from([0xff]), 'edit', 'f.bin'))).toBe('FS_NOT_TEXT')
  })

  it('samples only the leading binary window', () => {
    expect(isBinarySample(Uint8Array.from([0x61, 0x00]))).toBe(true)
    const late = new Uint8Array(BINARY_SAMPLE_BYTES + 1).fill(0x61)
    late[BINARY_SAMPLE_BYTES] = 0
    expect(isBinarySample(late)).toBe(false)
  })
})
