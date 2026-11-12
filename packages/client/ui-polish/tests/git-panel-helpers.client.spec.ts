// @vitest-environment jsdom
/** GitPanel pure helpers: paths, diffs, graph lanes, and untracked grouping. */
import { describe, expect, it } from 'vitest'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  basename, buildUntrackedTree, diffCounts, dirname, formatDate, isConflictMarker, isImagePath,
  layoutGraph, parseUnifiedDiff, statusLetter, workspacePathOf,
} from '../src/client/GitPanel.tsx'
import type { GitCommit, GitFile } from '../src/client/git-client.ts'

const t = (key: string): string => key

const workspace = (path: string, sessionId: string): WorkspaceView => ({
  workspaceId: `w-${path}`,
  title: path,
  path,
  createdAt: '2026-01-01',
  sessionIds: [sessionId as SessionId],
}) as unknown as WorkspaceView

const commit = (hash: string, parents: string[] = []): GitCommit => ({
  hash, shortHash: hash.slice(0, 7), parents, author: '', email: '', date: '', subject: '', body: '',
})

const file = (path: string): GitFile => ({ status: '??', path })

describe('GitPanel path helpers', () => {
  it('resolves the workspace path for a session', () => {
    const items = [workspace('/a', 's-1'), workspace('/b', 's-2')]
    expect(workspacePathOf('s-2', items)).toBe('/b')
    expect(workspacePathOf('s-x', items)).toBeUndefined()
    expect(workspacePathOf(undefined, items)).toBeUndefined()
  })

  it('takes basenames and dirnames at every depth', () => {
    expect(basename('a/b/c.txt')).toBe('c.txt')
    expect(basename('single')).toBe('single')
    expect(dirname('a/b/c.txt')).toBe('a/b')
    expect(dirname('single')).toBe('')
    expect(dirname('/x')).toBe('')
  })

  it('formats valid dates and passes invalid input through', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date')
    expect(formatDate('2026-01-01T00:00:00.000Z')).not.toBe('')
  })

  it('recognizes image extensions case-insensitively', () => {
    expect(isImagePath('a/b.PNG')).toBe(true)
    expect(isImagePath('a/b.avif')).toBe(true)
    expect(isImagePath('a/b.txt')).toBe(false)
    expect(isImagePath('no-extension')).toBe(false)
  })

  it('finds conflict markers in any line', () => {
    expect(isConflictMarker('<<<<<<< HEAD')).toBe(true)
    expect(isConflictMarker('=======')).toBe(true)
    expect(isConflictMarker('>>>>>>> branch')).toBe(true)
    expect(isConflictMarker('plain')).toBe(false)
  })
})

describe('GitPanel diff parsing', () => {
  it('parses hunks, context, additions, deletions, and conflict rows', () => {
    const rows = parseUnifiedDiff([
      'diff --git a/f b/f',
      'index 111..222',
      '--- a/f',
      '+++ b/f',
      '@@ -2,2 +2,3 @@',
      ' same',
      '-old',
      '+new',
      '<<<<<<< HEAD',
      '=======',
      '>>>>>>> other',
      '+tail',
      'no-prefix',
    ].join('\n'))

    expect(rows.map(row => row.kind)).toEqual(['hunk', 'ctx', 'del', 'add', 'meta', 'meta', 'meta', 'add', 'ctx'])
    expect(rows[1]).toMatchObject({ oldNo: 2, newNo: 2 })
    expect(rows[2]).toMatchObject({ kind: 'del', text: 'old', oldNo: 3 })
    expect(rows[3]).toMatchObject({ kind: 'add', text: 'new', newNo: 3 })
    expect(rows[4]).toMatchObject({ kind: 'meta', text: '<<<<<<< HEAD' })
    expect(rows[8]).toMatchObject({ kind: 'ctx', text: 'no-prefix' })
  })

  it('counts only additions and deletions', () => {
    const rows = parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n c\n')
    expect(diffCounts(rows)).toEqual({ add: 1, del: 1 })
  })
})

describe('GitPanel commit graph', () => {
  it('reuses a parent lane and otherwise falls back to the first lane', () => {
    const nodes = layoutGraph([
      commit('a', ['b']),
      commit('b', ['c']),
      commit('c'),
      commit('d', ['z']),
    ])
    expect(nodes).toEqual([
      { hash: 'a', lane: 0, row: 0 },
      { hash: 'b', lane: 0, row: 1 },
      { hash: 'c', lane: 0, row: 2 },
      { hash: 'd', lane: 0, row: 3 },
    ])
  })

  it('keeps every parentless commit on a usable lane', () => {
    const commits: GitCommit[] = Array.from({ length: 10 }, (_, index): GitCommit => commit(`h${index}`, [`missing-${index}`]))
    const nodes = layoutGraph(commits)
    expect(nodes.map(node => node.lane)).toEqual(Array.from({ length: 10 }, () => 0))
  })
})

describe('GitPanel untracked tree', () => {
  it('groups root files separately from one and two level directories', () => {
    const tree = buildUntrackedTree([
      file('root.txt'),
      file('one/a.txt'),
      file('one/b.txt'),
      file('two/sub/deep.txt'),
      file('two/sub/other.txt'),
    ])
    expect(tree).toEqual([
      { dir: 'one', files: [file('one/a.txt'), file('one/b.txt')], subdirs: [] },
      { dir: 'two', files: [], subdirs: ['sub'] },
    ])
  })

  it('keeps one node per top directory even when deeper branches repeat', () => {
    const tree = buildUntrackedTree([file('a/b/x'), file('a/b/y'), file('a/c/z')])
    expect(tree).toEqual([{ dir: 'a', files: [], subdirs: ['b', 'c'] }])
  })
})

describe('GitPanel status letter', () => {
  it('prefers the index letter, then the worktree letter, then M', () => {
    expect(statusLetter('??', t)).toBe('git.letterUntracked')
    expect(statusLetter(' U', t)).toBe('git.letterUntracked')
    expect(statusLetter('MU', t)).toBe('git.letterUntracked')
    expect(statusLetter('M ', t)).toBe('M')
    expect(statusLetter(' M', t)).toBe('M')
    expect(statusLetter('  ', t)).toBe('M')
    expect(statusLetter('', t)).toBe('M')
  })
})
