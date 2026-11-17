import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expandInput,
  expandTemplate,
  executeTemplate,
  loadTemplates,
  parseArguments,
  parseTemplate,
  type PromptTemplate,
} from '../src/index.ts'

describe('parseArguments', () => {
  it('splits on whitespace and keeps empty input empty', () => {
    expect(parseArguments('  a  b ')).toEqual(['a', 'b'])
    expect(parseArguments('')).toEqual([])
  })

  it('honors quotes only at the start of an argument', () => {
    expect(parseArguments('"a b" c')).toEqual(['a b', 'c'])
    expect(parseArguments("it's here")).toEqual(["it's", 'here'])
  })

  it('escapes the same quote inside a quoted argument and keeps other backslashes', () => {
    expect(parseArguments('"a \\"fast\\" path"')).toEqual(['a "fast" path'])
    expect(parseArguments('"a \\\\ b"')).toEqual(['a \\\\ b'])
  })
})

describe('expandTemplate', () => {
  it('substitutes positional and all-arguments placeholders', () => {
    expect(expandTemplate('$1 and $2', ['a', 'b'])).toBe('a and b')
    expect(expandTemplate('$@', ['a', 'b'])).toBe('a b')
    expect(expandTemplate('$ARGUMENTS', ['a', 'b'])).toBe('a b')
    expect(expandTemplate('missing $3', ['a'])).toBe('missing ')
  })

  it('supports defaults and slices', () => {
    expect(expandTemplate('${1:-fallback}', [])).toBe('fallback')
    expect(expandTemplate('${1:-fallback}', ['given'])).toBe('given')
    expect(expandTemplate('${@:-fallback}', [])).toBe('fallback')
    expect(expandTemplate('${@:2}', ['a', 'b', 'c'])).toBe('b c')
    expect(expandTemplate('${@:2:1}', ['a', 'b', 'c'])).toBe('b')
  })

  it('leaves unknown placeholders empty', () => {
    expect(expandTemplate('${x}', ['a'])).toBe('')
  })
})

describe('parseTemplate', () => {
  it('reads description, argument hint, and body', () => {
    const template = parseTemplate('review', '---\ndescription: Review changes\nargument-hint: "[focus]"\n---\nReview ${1:-everything}.')
    expect(template).toMatchObject({ name: 'review', description: 'Review changes', argumentHint: '[focus]' })
    expect(template?.body).toBe('Review ${1:-everything}.')
  })

  it('rejects a file without frontmatter, description, or body', () => {
    expect(parseTemplate('x', 'no frontmatter')).toBeUndefined()
    expect(parseTemplate('x', '---\nargument-hint: "[a]"\n---\nbody')).toBeUndefined()
    expect(parseTemplate('x', '---\ndescription: d\n---\n   ')).toBeUndefined()
  })
})

describe('expandInput', () => {
  const templates = new Map<string, PromptTemplate>([
    ['review', { name: 'review', description: 'Review', body: 'Review $1 thoroughly.' }],
  ])

  it('expands a matching template command', () => {
    expect(expandInput(templates, '/review auth')).toBe('Review auth thoroughly.')
  })

  it('returns undefined for ordinary input', () => {
    expect(expandInput(templates, 'hello')).toBeUndefined()
    expect(expandInput(templates, '/unknown x')).toBeUndefined()
  })
})

describe('executeTemplate', () => {
  it('injects the expanded text as one user message', async () => {
    const sent: string[] = []
    const invocation = {
      agent: { followup: (message: { content: readonly { type: string; text?: string }[] }) => {
        sent.push(message.content.map(block => block.text ?? '').join(''))
      } },
      rawInput: 'auth',
    } as never
    const result = executeTemplate(invocation, {
      name: 'review',
      description: 'Review',
      body: 'Review $1 thoroughly.',
    })
    expect(result.kind).toBe('success')
    expect(sent).toEqual(['Review auth thoroughly.'])
  })
})

describe('loadTemplates', () => {
  const tmp = fileURLToPath(new URL('../../../../tmp/', import.meta.url))

  it('loads markdown children of one directory and skips the rest', async () => {
    await mkdir(tmp, { recursive: true })
    const dir = await mkdtemp(join(tmp, 'prompt-templates-'))
    try {
      await writeFile(join(dir, 'a.md'), '---\ndescription: A\n---\nBody A $1.')
      await writeFile(join(dir, 'b.md'), 'no frontmatter')
      await writeFile(join(dir, 'c.txt'), '---\ndescription: C\n---\nBody C.')
      const templates = await loadTemplates([dir])
      expect([...templates.keys()]).toEqual(['a'])
      expect(templates.get('a')?.body).toBe('Body A $1.')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores a missing directory', async () => {
    expect((await loadTemplates([join(tmp, 'missing-prompt-templates-dir')])).size).toBe(0)
  })

  it('ignores an unreadable directory', async () => {
    await mkdir(tmp, { recursive: true })
    const dir = await mkdtemp(join(tmp, 'prompt-templates-'))
    try {
      await writeFile(join(dir, 'a.md'), '---\ndescription: A\n---\nBody A.')
      await rm(dir, { recursive: true, force: true })
      const templates = await loadTemplates([dir])
      expect(templates.size).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
