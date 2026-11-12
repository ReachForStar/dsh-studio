import { describe, expect, it } from 'vitest'
import { healStreamingMarkdown } from '../src/markdown/heal.ts'

describe('healStreamingMarkdown', () => {
  it.each([
    ['', ''],
    ['plain text', 'plain text'],
    ['hello **world**', 'hello **world**'],
    ['`closed`', '`closed`'],
    ['[label](https://example.com)', '[label](https://example.com)'],
    ['*em* and **strong**', '*em* and **strong**'],
  ])('leaves complete text %j unchanged', (input, expected) => {
    expect(healStreamingMarkdown(input)).toBe(expected)
  })

  it('closes an unterminated code span with a run of the same length', () => {
    expect(healStreamingMarkdown('run `command')).toBe('run `command`')
    expect(healStreamingMarkdown('run ``a`b')).toBe('run ``a`b``')
  })

  it('closes an unterminated strong or emphasis run', () => {
    expect(healStreamingMarkdown('hello **wor')).toBe('hello **wor**')
    expect(healStreamingMarkdown('hello *wor')).toBe('hello *wor*')
    expect(healStreamingMarkdown('hello _wor')).toBe('hello _wor_')
    expect(healStreamingMarkdown('hello ***wor')).toBe('hello ***wor***')
  })

  it('closes nested emphasis innermost first', () => {
    expect(healStreamingMarkdown('**a *b')).toBe('**a *b***')
  })

  it('closes an unterminated strikethrough', () => {
    expect(healStreamingMarkdown('hello ~~gone')).toBe('hello ~~gone~~')
  })

  it('leaves a bare opening marker with no content alone', () => {
    expect(healStreamingMarkdown('hello **')).toBe('hello **')
    expect(healStreamingMarkdown('hello * ')).toBe('hello * ')
    expect(healStreamingMarkdown('[label](')).toBe('[label](')
  })

  it('closes an unterminated link destination that already has content', () => {
    expect(healStreamingMarkdown('[label](https://exa')).toBe('[label](https://exa)')
    expect(healStreamingMarkdown('[label](https://exa) tail **x')).toBe('[label](https://exa) tail **x**')
  })

  it('does not treat intraword underscores as emphasis', () => {
    expect(healStreamingMarkdown('snake_case_name')).toBe('snake_case_name')
    expect(healStreamingMarkdown('中文_词')).toBe('中文_词')
  })

  it('ignores escaped markers', () => {
    expect(healStreamingMarkdown('literal \\*star')).toBe('literal \\*star')
    expect(healStreamingMarkdown('literal \\`tick')).toBe('literal \\`tick')
  })

  it('heals after a closed fence but never inside one', () => {
    expect(healStreamingMarkdown('```ts\nconst a = `x\n```\nthen **bold')).toBe('```ts\nconst a = `x\n```\nthen **bold**')
    expect(healStreamingMarkdown('```ts\nconst a = 1 **')).toBe('```ts\nconst a = 1 **')
    expect(healStreamingMarkdown('~~~\n**text')).toBe('~~~\n**text')
  })

  it('keeps marker-like lines inside a fence from closing it early', () => {
    expect(healStreamingMarkdown('````\n```\n')).toBe('````\n```\n')
    expect(healStreamingMarkdown('```\ncode\n~~\n')).toBe('```\ncode\n~~\n')
  })

  it('handles CRLF lines', () => {
    expect(healStreamingMarkdown('first\r\nsecond **x')).toBe('first\r\nsecond **x**')
  })

  it('ignores emphasis characters inside a code span', () => {
    expect(healStreamingMarkdown('use `a*b` now')).toBe('use `a*b` now')
    expect(healStreamingMarkdown('use `a*b')).toBe('use `a*b`')
  })

  it('treats a closing run as closing even when it could also open', () => {
    expect(healStreamingMarkdown('**a** then *b')).toBe('**a** then *b*')
  })

  it('closes emphasis that follows a destination-looking prefix', () => {
    expect(healStreamingMarkdown('a(b) *c')).toBe('a(b) *c*')
  })

  it('heals a construct that starts the text', () => {
    expect(healStreamingMarkdown('**start')).toBe('**start**')
  })

  it('tracks content and spaces inside an open destination', () => {
    expect(healStreamingMarkdown('[a](b c')).toBe('[a](b c)')
    expect(healStreamingMarkdown('[a]( ')).toBe('[a]( ')
  })

  it('treats plain parentheses as text', () => {
    expect(healStreamingMarkdown('([')).toBe('([')
  })

  it('keeps block boundaries transparent to inline healing', () => {
    expect(healStreamingMarkdown('line\n**next')).toBe('line\n**next**')
    expect(healStreamingMarkdown('para\n\n**x')).toBe('para\n\n**x**')
  })

  it('ignores a trailing escape character', () => {
    expect(healStreamingMarkdown('end\\')).toBe('end\\')
  })
})

describe('healStreamingMarkdown edge runs', () => {
  it('keeps a mismatched backtick run inside a code span', () => {
    expect(healStreamingMarkdown('`a``b')).toBe('`a``b`')
  })

  it('marks indented fence lines and blank lines', () => {
    expect(healStreamingMarkdown('   ```\n**x')).toBe('   ```\n**x')
    expect(healStreamingMarkdown('```\n\n```\n**y')).toBe('```\n\n```\n**y**')
  })
})
