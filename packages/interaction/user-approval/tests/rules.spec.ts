import { describe, expect, it } from 'vitest'
import { evaluateApprovalRules, matchApprovalPattern } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRule } from '@deepseek-ai/dsh-user-approval'
import { commandPrefixOf, matchCommandPrefix, splitCommandWords } from '../src/rules.ts'

const rule = (action: string, resource: string, effect: ApprovalRule['effect']): ApprovalRule =>
  ({ action, resource, effect, match: 'glob' })

describe('matchApprovalPattern', () => {
  it('matches literal text and wildcards across separators', () => {
    expect(matchApprovalPattern('write', 'write')).toBe(true)
    expect(matchApprovalPattern('write', 'reads')).toBe(false)
    expect(matchApprovalPattern('src/*', 'src/index.ts')).toBe(true)
    expect(matchApprovalPattern('src/*.ts', 'src/deep/nested/file.ts')).toBe(true)
    expect(matchApprovalPattern('src/*.ts', 'src/file.js')).toBe(false)
    expect(matchApprovalPattern('?at', 'cat')).toBe(true)
    expect(matchApprovalPattern('?at', 'coat')).toBe(false)
  })

  it('treats regex metacharacters in a pattern literally', () => {
    for (const pattern of ['a.b', 'a+b', '(x)', '[y]', '{z}', 'a|b', 'a\\b', 'a$']) {
      expect(matchApprovalPattern(pattern, pattern)).toBe(true)
      expect(matchApprovalPattern(pattern, `${pattern}x`)).toBe(false)
    }
  })
})

describe('evaluateApprovalRules', () => {
  it('returns undefined without rules and without a match', () => {
    expect(evaluateApprovalRules([], { action: 'write', resources: ['a.md'] })).toBeUndefined()
    expect(evaluateApprovalRules([rule('bash', '*', 'allow')], { action: 'write', resources: ['a.md'] })).toBeUndefined()
  })

  it('matches a rule against any one declared resource', () => {
    expect(evaluateApprovalRules([rule('write', 'notes/**', 'allow')], {
      action: 'write', resources: ['src/a.ts', 'notes/guide.txt'],
    })).toBe('allow')
  })

  it('matches a named resource rule only against a declared resource', () => {
    const rules = [rule('echo', 'notes.txt', 'allow')]
    expect(evaluateApprovalRules(rules, { action: 'echo', resources: [] })).toBeUndefined()
    expect(evaluateApprovalRules(rules, { action: 'echo', resources: ['notes.txt'] })).toBe('allow')
  })

  it('lets the last matching rule win so a narrow exception can follow a broad rule', () => {
    const rules = [
      rule('bash', '*', 'allow'),
      rule('bash', 'git *', 'deny'),
      rule('bash', 'git status', 'allow'),
    ]
    expect(evaluateApprovalRules(rules, { action: 'bash', resources: ['git push'] })).toBe('deny')
    expect(evaluateApprovalRules(rules, { action: 'bash', resources: ['git status'] })).toBe('allow')
    expect(evaluateApprovalRules(rules, { action: 'bash', resources: ['ls'] })).toBe('allow')
  })

  it('supports an explicit ask effect that overrides an earlier allow', () => {
    const rules = [rule('write', '**', 'allow'), rule('write', 'secrets/**', 'ask')]
    expect(evaluateApprovalRules(rules, { action: 'write', resources: ['secrets/key'] })).toBe('ask')
    expect(evaluateApprovalRules(rules, { action: 'write', resources: ['notes/guide.txt'] })).toBe('allow')
  })
})

describe('command prefixes', () => {
  it('matches whole leading words only', () => {
    expect(matchCommandPrefix('git status', 'git status')).toBe(true)
    expect(matchCommandPrefix('git status', 'git status -s')).toBe(true)
    expect(matchCommandPrefix('git status', 'git statuspage')).toBe(false)
    expect(matchCommandPrefix('git status', 'git push')).toBe(false)
    expect(matchCommandPrefix('git', 'git push')).toBe(true)
    expect(matchCommandPrefix('git status -s', 'git status')).toBe(false)
  })

  it('rejects commands whose effect is not visible in their words', () => {
    for (const command of [
      'git status && rm -rf build',
      'git status; rm -rf build',
      'git status | tee log',
      'git status > out.txt',
      'git status $(rm -rf build)',
      'git status `rm -rf build`',
      'git status\nrm -rf build',
      'git "unterminated',
    ]) {
      expect(matchCommandPrefix('git status', command)).toBe(false)
    }
  })

  it('honors quoting and escapes without treating quoted separators as operators', () => {
    expect(splitCommandWords('git commit -m "one two"')).toEqual(['git', 'commit', '-m', 'one two'])
    expect(splitCommandWords('git commit -m \'a;b\'')).toEqual(['git', 'commit', '-m', 'a;b'])
    expect(splitCommandWords('git\\ status')).toEqual(['git status'])
    expect(matchCommandPrefix('git commit', 'git commit -m "a && b"')).toBe(true)
  })

  it('derives a conservative prefix from the first words', () => {
    expect(commandPrefixOf('git status -s')).toBe('git status')
    expect(commandPrefixOf('rm -rf build')).toBe('rm')
    expect(commandPrefixOf('git -C repo status')).toBe('git')
    expect(commandPrefixOf('git status && rm -rf build')).toBeUndefined()
  })

  it('evaluates prefix rules against commands while glob rules keep their reach', () => {
    const rules: ApprovalRule[] = [
      { action: 'bash', resource: 'git status', effect: 'allow', match: 'prefix' },
    ]
    expect(evaluateApprovalRules(rules, { action: 'bash', resources: ['git status -s'] })).toBe('allow')
    expect(evaluateApprovalRules(rules, { action: 'bash', resources: ['git push'] })).toBeUndefined()
    expect(evaluateApprovalRules(rules, { action: 'bash', resources: ['git status && sudo rm -rf /'] })).toBeUndefined()
  })
})
