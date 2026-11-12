/** LaTeX host service internals: command execution, engine discovery, request
 * parsing, path validation, project walkers, graphics supply, and the writing
 * bridge, exercised directly instead of through `/latex` routes. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  aiWrite, bodyHistory, bodyOptionalString, bodyString, bodyText, collectGraphicsReferences,
  findInWorkspace, findProjects, isAborted, isDirectoryEntry, listProjectFiles,
  locateProjectFile, mirrorProject, probePackage, readJson, resolveProjectDir, resolveProjectPath,
  runAiWrite, runCommand, supplyWorkspaceGraphics, writeMessages,
} from '../src/latex-service.ts'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-latex-internals-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write an executable fixture command. */
async function executable(path: string, source: string): Promise<string> {
  await writeFile(path, source)
  await chmod(path, 0o755)
  return path
}

/** A fresh module instance, so the engine and cache state starts empty. */
async function freshService(): Promise<typeof import('../src/latex-service.ts')> {
  vi.resetModules()
  return import('../src/latex-service.ts')
}

/** Run a body with PATH replaced, restoring the previous value afterwards. */
async function withPath<T>(path: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH
  process.env.PATH = path
  try {
    return await body()
  } finally {
    process.env.PATH = previous
  }
}

/** Run a body with the process working directory replaced. */
async function withCwd<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return await body()
  } finally {
    process.chdir(previous)
  }
}

/** A command fixture that succeeds without any external program. */
const PROBE_SCRIPT = '#!/bin/sh\nexit 0\n'

describe('runCommand', () => {
  it('returns stdout with the exit code', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("hello")'], root, 5000)
    expect(result.stdout).toContain('hello')
    expect(result.code).toBe(0)
  })

  it('merges stderr into the output and reports a non-zero code', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'],
      root,
      5000,
    )
    expect(result.stdout).toContain('out')
    expect(result.stdout).toContain('err')
    expect(result.code).toBe(3)
  })

  it('rejects when the command exceeds its deadline', async () => {
    await expect(runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], root, 150))
      .rejects.toThrow('timed out after 150 ms')
  })

  it('rejects when stdout exceeds the output bound', async () => {
    await expect(runCommand(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.alloc(9 * 1024 * 1024))'],
      root,
      20_000,
    )).rejects.toThrow('output too large')
  }, 30_000)

  it('rejects when stderr exceeds the output bound', async () => {
    await expect(runCommand(
      process.execPath,
      ['-e', 'process.stderr.write(Buffer.alloc(9 * 1024 * 1024))'],
      root,
      20_000,
    )).rejects.toThrow('output too large')
  }, 30_000)

  it('rejects when the executable cannot be spawned', async () => {
    await expect(runCommand(join(root, 'no-such-command'), [], root, 5000)).rejects.toThrow()
  })

  it('reports a signal-terminated child as exit code -1', async () => {
    const result = await runCommand(process.execPath, ['-e', "process.kill(process.pid, 'SIGKILL')"], root, 5000)
    expect(result.code).toBe(-1)
  })

  it('runs a .cmd command through the shell', async () => {
    const command = await executable(join(root, 'probe.cmd'), '#!/bin/sh\necho shell-ok\nexit 0\n')
    const result = await runCommand(command, [], root, 5000)
    expect(result.stdout).toContain('shell-ok')
    expect(result.code).toBe(0)
  })
})

describe('engine discovery', () => {
  it('reports no engine when neither PATH nor the TeX Live layout holds one', async () => {
    const svc = await freshService()
    await withPath('', async () => {
      expect(await svc.locateEngine('xelatex')).toBeNull()
      await expect(svc.requireEngine('tlmgr')).rejects.toThrow('tlmgr not found')
      await expect(svc.xelatex()).rejects.toThrow('xelatex not found')
    })
  })

  it('resolves xelatex from PATH and reuses the cached answer', async () => {
    const bin = join(root, 'bin-path')
    await mkdir(bin, { recursive: true })
    await executable(join(bin, 'xelatex'), PROBE_SCRIPT)
    const svc = await freshService()
    await withPath(bin, async () => {
      expect(await svc.xelatexIfInstalled()).toBe('xelatex')
      process.env.PATH = ''
      expect(await svc.xelatexIfInstalled()).toBe('xelatex')
      expect(await svc.xelatex()).toBe('xelatex')
    })
  })

  it('resolves tlmgr and bibtex once each', async () => {
    const bin = join(root, 'bin-engines')
    await mkdir(bin, { recursive: true })
    await executable(join(bin, 'tlmgr'), PROBE_SCRIPT)
    await executable(join(bin, 'bibtex'), PROBE_SCRIPT)
    const svc = await freshService()
    await withPath(bin, async () => {
      expect(await svc.tlmgr()).toBe('tlmgr')
      expect(await svc.tlmgr()).toBe('tlmgr')
      expect(await svc.bibtex()).toBe('bibtex')
      expect(await svc.bibtex()).toBe('bibtex')
    })
  })

  it('probes the Windows TeX Live layout for an .exe', async () => {
    const layout = join(root, 'layout-exe')
    const bin = join(layout, 'C:', 'texlive', '2024', 'bin', 'windows')
    await mkdir(bin, { recursive: true })
    await executable(join(bin, 'xelatex.exe'), PROBE_SCRIPT)
    await withPath('', () => withCwd(layout, async () => {
      const svc = await freshService()
      expect(await svc.locateEngine('xelatex')).toBe('C:/texlive/2024/bin/windows/xelatex.exe')
    }))
  })

  it('falls back to the Windows TeX Live .bat form', async () => {
    const layout = join(root, 'layout-bat')
    const bin = join(layout, 'C:', 'texlive', '2023', 'bin', 'windows')
    await mkdir(bin, { recursive: true })
    await executable(join(bin, 'xelatex.bat'), PROBE_SCRIPT)
    await withPath('', () => withCwd(layout, async () => {
      const svc = await freshService()
      expect(await svc.locateEngine('xelatex')).toBe('C:/texlive/2023/bin/windows/xelatex.bat')
    }))
  })
})

describe('probePackage', () => {
  /** A kpsewhich fixture printing the configured path and exiting with the configured code. */
  const KPSEWHICH_SCRIPT = [
    '#!/usr/bin/env node',
    "process.stdout.write(process.env.FAKE_KPSEWHICH_PATH ?? '')",
    "process.exit(Number(process.env.FAKE_KPSEWHICH_EXIT ?? '0'))",
  ].join('\n')

  it('reports every package missing without an engine', async () => {
    expect(await probePackage(null, 'ctex.sty')).toBe(false)
  })

  it('reports a resolved package file when kpsewhich prints a path', async () => {
    const bin = join(root, 'bin-kpse')
    await mkdir(bin, { recursive: true })
    const engine = await executable(join(bin, 'xelatex'), PROBE_SCRIPT)
    await executable(join(bin, 'kpsewhich'), `${KPSEWHICH_SCRIPT}\n`)
    const previous = process.env.FAKE_KPSEWHICH_PATH
    process.env.FAKE_KPSEWHICH_PATH = '/texmf/ctex.sty'
    try {
      await withPath(`${bin}:${process.env.PATH ?? ''}`, async () => {
        expect(await probePackage(engine, 'ctex.sty')).toBe(true)
      })
    } finally {
      process.env.FAKE_KPSEWHICH_PATH = previous
    }
  })

  it('reports a package file missing when kpsewhich exits cleanly with no output', async () => {
    const bin = join(root, 'bin-kpse-empty')
    await mkdir(bin, { recursive: true })
    const engine = await executable(join(bin, 'xelatex'), PROBE_SCRIPT)
    await executable(join(bin, 'kpsewhich'), `${KPSEWHICH_SCRIPT}\n`)
    const previous = process.env.FAKE_KPSEWHICH_PATH
    delete process.env.FAKE_KPSEWHICH_PATH
    try {
      await withPath(`${bin}:${process.env.PATH ?? ''}`, async () => {
        expect(await probePackage(engine, 'xeCJK.sty')).toBe(false)
      })
    } finally {
      process.env.FAKE_KPSEWHICH_PATH = previous
    }
  })

  it('reports a package file missing when every kpsewhich candidate fails', async () => {
    const bin = join(root, 'bin-kpse-fail')
    await mkdir(bin, { recursive: true })
    const engine = await executable(join(bin, 'xelatex'), PROBE_SCRIPT)
    await executable(join(bin, 'kpsewhich'), [
      '#!/usr/bin/env node',
      'process.exit(1)',
    ].join('\n'))
    await withPath(`${bin}:${process.env.PATH ?? ''}`, async () => {
      expect(await probePackage(engine, 'FandolSong-Regular.otf')).toBe(false)
    })
  })
})

/** A request double that emits the given body parts. */
function bodyRequest(parts: { data?: readonly string[]; end?: boolean; error?: Error }): IncomingMessage {
  return {
    on(event: 'data' | 'end' | 'error', fn: (value?: Buffer | Error) => void) {
      if (event === 'data') for (const part of parts.data ?? []) fn(Buffer.from(part))
      if (event === 'end' && parts.error === undefined) fn()
      if (event === 'error' && parts.error !== undefined) fn(parts.error)
    },
  } as unknown as IncomingMessage
}

describe('request parsing', () => {
  it('reads a JSON object body', async () => {
    await expect(readJson(bodyRequest({ data: ['{"cwd":"/ws"}'], end: true }))).resolves.toEqual({ cwd: '/ws' })
  })

  it('reads an empty body as an empty object', async () => {
    await expect(readJson(bodyRequest({ end: true }))).resolves.toEqual({})
  })

  it('rejects an invalid JSON body', async () => {
    await expect(readJson(bodyRequest({ data: ['not json'], end: true })))
      .rejects.toThrow('invalid JSON body')
  })

  it('rejects JSON that is not an object', async () => {
    await expect(readJson(bodyRequest({ data: ['null'], end: true }))).rejects.toThrow('must be an object')
    await expect(readJson(bodyRequest({ data: ['5'], end: true }))).rejects.toThrow('must be an object')
    await expect(readJson(bodyRequest({ data: ['[]'], end: true }))).rejects.toThrow('must be an object')
  })

  it('propagates a request error', async () => {
    await expect(readJson(bodyRequest({ error: new Error('socket closed') }))).rejects.toThrow('socket closed')
  })

  it('validates required and optional body strings', () => {
    expect(bodyString({ path: 'main.tex' }, 'path')).toBe('main.tex')
    expect(() => bodyString({}, 'path')).toThrow('"path" must be a non-empty string')
    expect(() => bodyString({ path: 3 }, 'path')).toThrow('"path" must be a non-empty string')
    expect(() => bodyString({ path: '' }, 'path')).toThrow('"path" must be a non-empty string')

    expect(bodyOptionalString({ dir: 'paper' }, 'dir')).toBe('paper')
    expect(bodyOptionalString({}, 'dir')).toBeUndefined()
    expect(bodyOptionalString({ dir: '' }, 'dir')).toBeUndefined()
    expect(bodyOptionalString({ dir: 4 }, 'dir')).toBeUndefined()
  })

  it('accepts an empty string only where the field may be empty', () => {
    expect(bodyText({ content: '' }, 'content')).toBe('')
    expect(() => bodyText({ content: 1 }, 'content')).toThrow('"content" must be a string')
  })

  it('validates the writing conversation history', () => {
    expect(bodyHistory({})).toEqual([])
    expect(() => bodyHistory({ history: 'x' })).toThrow('must be an array')
    expect(() => bodyHistory({ history: [null] })).toThrow('entries must be objects')
    expect(() => bodyHistory({ history: ['x'] })).toThrow('entries must be objects')
    expect(() => bodyHistory({ history: [{ role: 'system', text: 'x' }] })).toThrow('need a role and a text')
    expect(() => bodyHistory({ history: [{ role: 'user' }] })).toThrow('need a role and a text')
    expect(bodyHistory({
      history: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'answer' }],
    })).toEqual([{ role: 'user', text: 'first' }, { role: 'assistant', text: 'answer' }])
  })
})

describe('path validation', () => {
  it('resolves a nested project path', () => {
    expect(resolveProjectPath('/ws/paper', 'figures/a.png')).toBe('/ws/paper/figures/a.png')
    expect(resolveProjectPath('/ws/paper', '.')).toBe('/ws/paper')
  })

  it('rejects parent traversal and absolute paths', () => {
    expect(() => resolveProjectPath('/ws/paper', '../secret')).toThrow('invalid path')
    expect(() => resolveProjectPath('/ws/paper', '/etc/passwd')).toThrow('invalid path')
    expect(() => resolveProjectPath('/ws/paper', '\\windows\\path')).toThrow('invalid path')
  })

  it('resolves a project directory inside the workspace', () => {
    expect(resolveProjectDir('/ws', 'paper')).toBe('/ws/paper')
    expect(resolveProjectDir('/ws', '.')).toBe('/ws')
  })

  it('rejects a project directory that escapes the workspace', () => {
    expect(() => resolveProjectDir('/ws', '../outside')).toThrow('escapes the workspace')
  })
})

describe('project discovery', () => {
  it('discovers the workspace root and bounded nested projects', async () => {
    const workspace = join(root, 'discover')
    const deep = join(workspace, 'level1', 'level2', 'level3')
    await mkdir(join(deep, 'child'), { recursive: true })
    await writeFile(join(workspace, 'main.tex'), '% root\n')
    await writeFile(join(deep, 'paper.tex'), '% deep\n')
    await writeFile(join(deep, 'child', 'ignored.tex'), '% too deep\n')
    const projects = await findProjects(workspace)
    const paths = projects.map(project => project.path)
    expect(paths).toContain('.')
    expect(paths).toContain('level1/level2/level3')
    expect(paths).not.toContain('level1/level2/level3/child')
    expect(projects.find(project => project.path === '.')?.name).toBe('discover')
    expect(projects.find(project => project.path === '.')?.mainFiles).toEqual(['main.tex'])
    expect(projects.find(project => project.path === 'level1/level2/level3')?.mainFiles).toEqual(['paper.tex'])
  })

  it('returns no projects when the workspace path is not a directory', async () => {
    const file = join(root, 'not-a-workspace.txt')
    await writeFile(file, 'x')
    expect(await findProjects(file)).toEqual([])
  })
})

describe('project file listing', () => {
  it('lists nested directories and files with their sizes', async () => {
    const project = join(root, 'listing')
    await mkdir(join(project, 'notes', 'sub', 'deep', 'deeper'), { recursive: true })
    await mkdir(join(project, 'node_modules'), { recursive: true })
    await writeFile(join(project, 'main.tex'), 'abc')
    await writeFile(join(project, 'node_modules', 'skip.tex'), 'x')
    await symlink(join(project, 'no-such-target'), join(project, 'broken.tex'))
    const files = await listProjectFiles(project)
    const byPath = new Map(files.map(file => [file.path, file]))
    expect(byPath.get('notes')?.dir).toBe(true)
    expect(byPath.get('notes/sub/deep/deeper')?.dir).toBe(true)
    expect(byPath.get('main.tex')?.size).toBe(3)
    expect(byPath.get('broken.tex')?.size).toBe(0)
    // The listing stops at depth 3 and never walks node_modules.
    expect(byPath.has('notes/sub/deep/deeper/anything.txt')).toBe(false)
    expect(byPath.has('node_modules/skip.tex')).toBe(false)
  })

  it('stops at 500 entries', async () => {
    const project = join(root, 'listing-many')
    await mkdir(project, { recursive: true })
    for (let index = 0; index < 501; index += 1) {
      await writeFile(join(project, `f${String(index).padStart(3, '0')}.tex`), '')
    }
    const files = await listProjectFiles(project)
    expect(files).toHaveLength(500)
  })

  it('returns no entries when the project path is not a directory', async () => {
    const file = join(root, 'listing-file.txt')
    await writeFile(file, 'x')
    expect(await listProjectFiles(file)).toEqual([])
  })
})

describe('project mirroring', () => {
  it('copies compilable files, follows directory links, and reports unreadable entries', async () => {
    const project = join(root, 'mirror-src')
    const dest = join(root, 'mirror-dest')
    await mkdir(join(project, 'nested'), { recursive: true })
    await mkdir(join(project, 'node_modules'), { recursive: true })
    await mkdir(dest, { recursive: true })
    await writeFile(join(project, 'main.tex'), '% main\n')
    await writeFile(join(project, 'refs.bib'), '@book{k}\n')
    await writeFile(join(project, 'photo.PNG'), 'png')
    await writeFile(join(project, 'Makefile'), 'all:\n')
    await writeFile(join(project, 'script.py'), 'print(1)\n')
    await writeFile(join(project, 'nested', 'fig.png'), 'png')
    await writeFile(join(project, 'node_modules', 'skip.tex'), 'x')
    await symlink(join(project, 'nested'), join(project, 'linked'))
    await symlink(join(project, 'gone.tex'), join(project, 'missing-target.tex'))
    const skipped = await mirrorProject(project, dest)
    await expect(readFile(join(dest, 'main.tex'), 'utf8')).resolves.toBe('% main\n')
    await expect(readFile(join(dest, 'refs.bib'), 'utf8')).resolves.toBe('@book{k}\n')
    await expect(readFile(join(dest, 'photo.PNG'), 'utf8')).resolves.toBe('png')
    await expect(readFile(join(dest, 'nested', 'fig.png'), 'utf8')).resolves.toBe('png')
    await expect(readFile(join(dest, 'linked', 'fig.png'), 'utf8')).resolves.toBe('png')
    expect(skipped).toContain('missing-target.tex')
    await expect(readFile(join(dest, 'Makefile'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(dest, 'script.py'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(dest, 'node_modules', 'skip.tex'), 'utf8')).rejects.toThrow()
  })

  it('skips a file above the per-file mirror bound', async () => {
    const project = join(root, 'mirror-huge')
    const dest = join(root, 'mirror-huge-dest')
    await mkdir(project, { recursive: true })
    await mkdir(dest, { recursive: true })
    await writeFile(join(project, 'main.tex'), '% main\n')
    await writeFile(join(project, 'huge.pdf'), '')
    await truncate(join(project, 'huge.pdf'), 64 * 1024 * 1024 + 1)
    const skipped = await mirrorProject(project, dest)
    expect(skipped).toContain('huge.pdf')
    await expect(readFile(join(dest, 'huge.pdf'))).rejects.toThrow()
  }, 30_000)

  it('stops at the project file-count bound', async () => {
    const project = join(root, 'mirror-many')
    const dest = join(root, 'mirror-many-dest')
    await mkdir(project, { recursive: true })
    await mkdir(dest, { recursive: true })
    for (let index = 0; index < 2001; index += 1) {
      await writeFile(join(project, `f${String(index).padStart(4, '0')}.tex`), '')
    }
    const skipped = await mirrorProject(project, dest)
    expect(skipped).toHaveLength(1)
    expect(await readdir(dest)).toHaveLength(2000)
  }, 60_000)

  it('mirrors nothing when the project path is not a directory', async () => {
    const file = join(root, 'mirror-file.txt')
    const dest = join(root, 'mirror-file-dest')
    await writeFile(file, 'x')
    await mkdir(dest, { recursive: true })
    expect(await mirrorProject(file, dest)).toEqual([])
  })

  it('treats entries by their resolved type', async () => {
    const dir = join(root, 'entry-kinds')
    await mkdir(join(dir, 'real-dir'), { recursive: true })
    await writeFile(join(dir, 'file.tex'), '')
    await symlink(join(dir, 'real-dir'), join(dir, 'dir-link'))
    await symlink(join(dir, 'no-target'), join(dir, 'broken-link'))
    const entries = await readdir(dir, { withFileTypes: true })
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    expect(await isDirectoryEntry(join(dir, 'real-dir'), byName.get('real-dir')!)).toBe(true)
    expect(await isDirectoryEntry(join(dir, 'file.tex'), byName.get('file.tex')!)).toBe(false)
    expect(await isDirectoryEntry(join(dir, 'dir-link'), byName.get('dir-link')!)).toBe(true)
    expect(await isDirectoryEntry(join(dir, 'broken-link'), byName.get('broken-link')!)).toBe(false)
  })
})

describe('graphics references', () => {
  it('collects referenced names and declared search paths from the mirror', async () => {
    const mirror = join(root, 'graphics-mirror')
    await mkdir(join(mirror, 'node_modules'), { recursive: true })
    await writeFile(join(mirror, 'main.tex'), [
      '\\includegraphics[width=1cm]{figs/a.png}',
      '\\includegraphics{figs/a.png}',
      '\\includegraphics{}',
      '\\graphicspath{{figs/}{more/}}',
      '\\graphicspath{{}{extra/}}',
    ].join('\n'))
    await writeFile(join(mirror, 'node_modules', 'skip.tex'), '\\includegraphics{hidden.png}\n')
    await symlink(join(mirror, 'gone.tex'), join(mirror, 'broken-source.tex'))
    const graphics = await collectGraphicsReferences(mirror)
    expect(graphics.references).toEqual(['figs/a.png'])
    expect(graphics.searchPaths).toEqual(['figs/', 'more/', 'extra/'])
  })

  it('returns an empty index when the mirror path is not a directory', async () => {
    const file = join(root, 'graphics-file.txt')
    await writeFile(file, 'x')
    expect(await collectGraphicsReferences(file)).toEqual({ references: [], searchPaths: [] })
  })
})

describe('workspace graphics supply', () => {
  it('copies a referenced file the mirror lacks from the workspace', async () => {
    const mirror = join(root, 'supply-mirror')
    const workspace = join(root, 'supply-workspace')
    await mkdir(mirror, { recursive: true })
    await mkdir(join(workspace, 'results'), { recursive: true })
    await writeFile(join(mirror, 'main.tex'), '\\includegraphics{a.png}\n')
    await writeFile(join(workspace, 'results', 'a.png'), 'from-workspace')
    const supplied = await supplyWorkspaceGraphics(mirror, '', workspace)
    expect(supplied).toEqual(['a.png'])
    await expect(readFile(join(mirror, 'a.png'), 'utf8')).resolves.toBe('from-workspace')
  })

  it('leaves a reference the project already holds in place', async () => {
    const mirror = join(root, 'supply-local')
    const workspace = join(root, 'supply-local-workspace')
    await mkdir(mirror, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(join(mirror, 'main.tex'), '\\includegraphics{b.png}\n\\includegraphics{c.png}\n')
    await writeFile(join(mirror, 'b.png'), 'local')
    const supplied = await supplyWorkspaceGraphics(mirror, '', workspace)
    expect(supplied).toEqual([])
  })

  it('resolves a reference through a declared graphicspath directory', async () => {
    const mirror = join(root, 'supply-graphicspath')
    const workspace = join(root, 'supply-graphicspath-workspace')
    await mkdir(join(mirror, 'figs'), { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(join(mirror, 'main.tex'), '\\graphicspath{{figs/}}\n\\includegraphics{d.png}\n')
    await writeFile(join(mirror, 'figs', 'd.png'), 'local')
    const supplied = await supplyWorkspaceGraphics(mirror, '', workspace)
    expect(supplied).toEqual([])
  })
})

describe('project file lookup', () => {
  it('returns the given relative path when it exists', async () => {
    const project = join(root, 'lookup-exact')
    await mkdir(join(project, 'figures'), { recursive: true })
    await writeFile(join(project, 'figures', 'a.png'), 'png')
    expect(locateProjectFile(project, 'figures/a.png')).toBe('figures/a.png')
  })

  it('finds a file by basename in a subdirectory', async () => {
    const project = join(root, 'lookup-nested')
    await mkdir(join(project, 'figures'), { recursive: true })
    await writeFile(join(project, 'figures', 'b.png'), 'png')
    expect(locateProjectFile(project, 'b.png')).toBe('figures/b.png')
  })

  it('returns undefined for a file the project does not hold', async () => {
    const project = join(root, 'lookup-missing')
    await mkdir(project, { recursive: true })
    expect(locateProjectFile(project, 'nowhere.png')).toBeUndefined()
    const file = join(root, 'lookup-file.txt')
    await writeFile(file, 'x')
    expect(locateProjectFile(file, 'nowhere.png')).toBeUndefined()
  })
})

describe('workspace file search', () => {
  it('finds a file by name anywhere under the workspace', async () => {
    const workspace = join(root, 'search-workspace')
    await mkdir(join(workspace, 'experiments', 'results'), { recursive: true })
    await writeFile(join(workspace, 'experiments', 'results', 'fig.png'), 'png')
    await expect(findInWorkspace(workspace, 'fig.png'))
      .resolves.toBe(join(workspace, 'experiments', 'results', 'fig.png'))
  })

  it('returns undefined when the workspace does not hold the name', async () => {
    const workspace = join(root, 'search-empty')
    await mkdir(workspace, { recursive: true })
    expect(await findInWorkspace(workspace, 'fig.png')).toBeUndefined()
    const file = join(root, 'search-file.txt')
    await writeFile(file, 'x')
    expect(await findInWorkspace(file, 'fig.png')).toBeUndefined()
  })
})

const TEXT = (text: string, index = 0) => ({ type: 'text-delta' as const, index, text })
const REASONING = (text: string, index = 0) => ({ type: 'reasoning-delta' as const, index, text })
const FINISH = () => ({ type: 'finish' as const, reason: { kind: 'stop' as const } })

/** A fake llm service over a fixed provider catalog and scripted streams. */
function fakeContext(
  catalog: Record<string, { id: string; name: string }[]>,
  streams: Record<string, () => AsyncIterable<unknown>>,
  seen: unknown[] = [],
): Context {
  return {
    llm: {
      listProviders: () => Object.keys(catalog).map(id => ({ id })),
      listModels: async (provider: string) => catalog[provider] ?? [],
      stream: (options: { provider: string }) => {
        seen.push(options)
        const open = streams[options.provider]
        if (open === undefined) throw new Error(`no stream scripted for ${options.provider}`)
        return open()
      },
    },
  } as unknown as Context
}

/** One scripted stream emitting the given chunks. */
function emit(chunks: readonly unknown[]): () => AsyncIterable<unknown> {
  return async function* () {
    for (const chunk of chunks) yield chunk
  }
}

/** One scripted stream that fails before emitting anything. */
function fail(error: unknown): () => AsyncIterable<unknown> {
  return async function* () {
    throw error
  }
}

const REQUEST = {
  fileContent: '\\section{Intro}',
  selection: undefined,
  history: [],
  instruction: 'rewrite it',
}

/** The text blocks of one assembled message. */
function messageText(message: { readonly content: readonly unknown[] }): string {
  return message.content.map(part => (part as { text?: string }).text ?? '').join('')
}

describe('writing messages', () => {
  it('sends the selection and instruction on the first turn', () => {
    const messages = writeMessages({ ...REQUEST, selection: 'selected text' }, { provider: 'p', model: 'm' })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
    const text = messageText(messages[0]!)
    expect(text).toContain('LaTeX selection:\nselected text')
    expect(text).toContain('Instruction:\nrewrite it')
  })

  it('sends the file content when nothing is selected', () => {
    const messages = writeMessages(REQUEST, { provider: 'p', model: 'm' })
    expect(messageText(messages[0]!)).toContain('LaTeX source:\n\\section{Intro}')
  })

  it('keeps earlier turns and tags the assistant reply with its route', () => {
    const messages = writeMessages({
      ...REQUEST,
      history: [
        { role: 'user', text: 'first ask' },
        { role: 'assistant', text: 'first answer' },
        { role: 'user', text: 'second ask' },
      ],
    }, { provider: 'gateway', model: 'm1' })
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'user'])
    expect(messageText(messages[0]!)).toContain('Instruction:\nfirst ask')
    expect(messageText(messages[1]!)).toBe('first answer')
    expect(messageText(messages[2]!)).toBe('second ask')
    expect(messageText(messages[3]!)).toBe('rewrite it')
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      source: { provider: 'gateway', model: 'm1' },
    })
  })
})

describe('abort inspection', () => {
  it('reports an absent or unfired signal as not aborted', () => {
    expect(isAborted(undefined)).toBe(false)
    expect(isAborted(new AbortController().signal)).toBe(false)
  })

  it('reports a fired signal as aborted', () => {
    const controller = new AbortController()
    controller.abort()
    expect(isAborted(controller.signal)).toBe(true)
  })
})

describe('runAiWrite', () => {
  it('streams the deltas, forwards the abort signal, and trims the text', async () => {
    const seen: unknown[] = []
    const ctx = fakeContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, {
      gateway: emit([TEXT('  \\section{A}'), TEXT('\nB  '), FINISH()]),
    }, seen)
    const controller = new AbortController()
    const deltas: string[] = []
    const text = await runAiWrite(
      ctx,
      { provider: 'gateway', model: 'm1' },
      REQUEST,
      delta => deltas.push(delta),
      controller.signal,
    )
    expect(text).toBe('\\section{A}\nB')
    expect(deltas).toEqual(['  \\section{A}', '\nB  '])
    expect((seen[0] as { signal?: AbortSignal }).signal).toBe(controller.signal)
  })

  it('rejects a stream that returns no text block', async () => {
    const ctx = fakeContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, {
      gateway: emit([REASONING('thinking'), FINISH()]),
    })
    await expect(runAiWrite(ctx, { provider: 'gateway', model: 'm1' }, REQUEST, () => {}))
      .rejects.toThrow('the model returned no text')
  })
})

describe('aiWrite', () => {
  it('returns the first route output and forwards every delta', async () => {
    const ctx = fakeContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, {
      gateway: emit([TEXT('a'), TEXT('b'), FINISH()]),
    })
    const deltas: string[] = []
    await expect(aiWrite(ctx, undefined, REQUEST, delta => deltas.push(delta))).resolves.toBe('ab')
    expect(deltas).toEqual(['a', 'b'])
  })

  it('falls through to the next route when one fails before emitting', async () => {
    const ctx = fakeContext({
      official: [{ id: 'm1', name: 'Model 1' }],
      mirror: [{ id: 'm2', name: 'Model 2' }],
    }, {
      official: fail(new Error('missing credentials')),
      mirror: emit([TEXT('ok'), FINISH()]),
    })
    await expect(aiWrite(ctx, undefined, REQUEST, () => {})).resolves.toBe('ok')
  })

  it('does not fall through once a delta reached the client', async () => {
    const ctx = fakeContext({
      official: [{ id: 'm1', name: 'Model 1' }],
      mirror: [{ id: 'm2', name: 'Model 2' }],
    }, {
      official: async function* () {
        yield TEXT('partial')
        throw new Error('stream dropped')
      },
      mirror: emit([TEXT('never'), FINISH()]),
    })
    await expect(aiWrite(ctx, undefined, REQUEST, () => {})).rejects.toThrow('stream dropped')
  })

  it('does not fall through when the request was aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = fakeContext({
      official: [{ id: 'm1', name: 'Model 1' }],
      mirror: [{ id: 'm2', name: 'Model 2' }],
    }, {
      official: fail(new Error('aborted')),
      mirror: emit([TEXT('never'), FINISH()]),
    })
    await expect(aiWrite(ctx, undefined, REQUEST, () => {}, controller.signal)).rejects.toThrow('aborted')
  })

  it('aggregates every route failure, including a non-Error rejection', async () => {
    const ctx = fakeContext({
      official: [{ id: 'm1', name: 'Model 1' }],
      mirror: [{ id: 'm2', name: 'Model 2' }],
    }, {
      official: fail(new Error('down')),
      mirror: fail('offline'),
    })
    await expect(aiWrite(ctx, undefined, REQUEST, () => {}))
      .rejects.toThrow('no model produced a result — official/m1: down; mirror/m2: offline')
  })

  it('aggregates a route that produced no text', async () => {
    const ctx = fakeContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, {
      gateway: emit([FINISH()]),
    })
    await expect(aiWrite(ctx, undefined, REQUEST, () => {}))
      .rejects.toThrow('gateway/m1: the model returned no text')
  })
})
