/** LaTeX panel host service: project discovery, file read/write, clean, fonts,
 * log excerpt, and — when a TeX distribution is present — a real xelatex
 * compile of a small Chinese + English document. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compileProject, explainMissingReferences, extractBibtexExcerpt, extractLogExcerpt, findProjects,
  handleLatexRequest, listProjectFiles,
} from '../src/latex-service.ts'
import { workspaceCwdResolver } from '../src/git-service.ts'

let workspace: string
let xelatexPath: string | null = null

beforeAll(async () => {
  workspace = await mkdtemp(`${tmpdir()}/dsh-latex-svc-`)
  const candidates: string[] = []
  try {
    const { readdirSync } = await import('node:fs')
    for (const year of readdirSync('C:/texlive').sort().reverse()) {
      candidates.push(`C:/texlive/${year}/bin/windows/xelatex.exe`)
    }
  } catch {
    // No C:/texlive layout; fall back to PATH probing.
  }
  for (const candidate of candidates) {
    if (existsSync(candidate) && spawnSync(candidate, ['--version'], { timeout: 15_000 }).status === 0) {
      xelatexPath = candidate
      break
    }
  }
  if (xelatexPath === null && spawnSync('xelatex', ['--version'], { timeout: 15_000 }).status === 0) {
    xelatexPath = 'xelatex'
  }
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

/** In-memory response double capturing status and body. */
function responseDouble() {
  let statusCode = 0
  let body = ''
  let ended = false
  return {
    res: {
      writeHead(status: number) { statusCode = status },
      write(chunk: string) { body += chunk },
      end(payload?: string | Uint8Array) {
        if (payload !== undefined) body += payload.toString()
        ended = true
      },
      get writableEnded() { return ended },
      get headersSent() { return statusCode > 0 },
    },
    get status(): number { return statusCode },
    get raw(): string { return body },
    get json(): Record<string, unknown> { return JSON.parse(body) as Record<string, unknown> },
    /** NDJSON lines, for the streaming routes. */
    get lines(): Record<string, unknown>[] {
      return body.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    },
  }
}

/** Minimal request double: URL + method + optional JSON body. */
function requestDouble(path: string, method: string, body?: unknown) {
  return {
    url: path,
    method,
    on(event: 'data' | 'end' | 'error', fn: (chunk?: Buffer) => void) {
      if (event === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)))
      if (event === 'end') fn()
    },
  }
}

/** A stub Host context: no LLM provider (the AI route must fail fast). */
const ctxStub = {
  llm: {
    listProviders: () => [],
    listModels: async () => [],
    stream: () => { throw new Error('no stream in the stub') },
  },
} as never

/** Set up a minimal LaTeX project with one main file. */
async function makeProject(subdir: string, texName: string, content: string): Promise<string> {
  const dir = join(workspace, subdir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, texName), content)
  return dir
}

const MAIN_TEX = String.raw`\documentclass{article}
\begin{document}
Hello world. 你好，世界。
\end{document}
`

/** A valid 1x1 PNG, for figure references that must resolve to a real file. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('project discovery and file access', () => {
  it('finds directories containing .tex files, excluding node_modules', async () => {
    await makeProject('paper', 'main.tex', MAIN_TEX)
    await mkdir(join(workspace, 'node_modules', 'fake'), { recursive: true })
    await writeFile(join(workspace, 'node_modules', 'fake', 'x.tex'), '%x')
    const projects = await findProjects(workspace)
    const paths = projects.map(p => p.path)
    expect(paths).toContain('paper')
    expect(paths.some(p => p.includes('node_modules'))).toBe(false)
    expect(projects.find(p => p.path === 'paper')?.mainFiles).toEqual(['main.tex'])
  })

  it('lists files with the main file detected by the project scan', async () => {
    const dir = await makeProject('list1', 'main.tex', MAIN_TEX)
    await writeFile(join(dir, 'notes.tex'), '% notes\n')
    const files = await listProjectFiles(dir)
    expect(files.map(f => f.path)).toContain('main.tex')
    expect(files.map(f => f.path)).toContain('notes.tex')
    const projects = await findProjects(workspace)
    expect(projects.find(p => p.path === 'list1')?.mainFiles).toContain('main.tex')
  })

  it('reads and writes project files relative to the selected directory', async () => {
    await makeProject('rw', 'doc.tex', MAIN_TEX)
    const resolve = workspaceCwdResolver([workspace], workspace)
    const read = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/read', 'POST', { cwd: workspace, dir: 'rw', path: 'doc.tex' }) as never, read.res as never)
    expect(read.status).toBe(200)
    expect(String(read.json.content)).toBe(MAIN_TEX)
    const write = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/write', 'POST', { cwd: workspace, dir: 'rw', path: 'doc.tex', content: '% updated\n' }) as never, write.res as never)
    expect(write.status).toBe(200)
    const reRead = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/read', 'POST', { cwd: workspace, dir: 'rw', path: 'doc.tex' }) as never, reRead.res as never)
    expect(String(reRead.json.content)).toBe('% updated\n')
  })

  it('creates an empty file through the write route', async () => {
    await makeProject('rw-empty', 'doc.tex', MAIN_TEX)
    const resolve = workspaceCwdResolver([workspace], workspace)
    const write = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/write', 'POST', { cwd: workspace, dir: 'rw-empty', path: 'notes/new.tex', content: '' }) as never, write.res as never)
    expect(write.status).toBe(200)
    const read = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/read', 'POST', { cwd: workspace, dir: 'rw-empty', path: 'notes/new.tex' }) as never, read.res as never)
    expect(read.status).toBe(200)
    expect(String(read.json.content)).toBe('')
  })

  it('rejects paths that escape the project', async () => {
    await makeProject('esc', 'doc.tex', MAIN_TEX)
    const resolve = workspaceCwdResolver([workspace], workspace)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/read', 'POST', { cwd: workspace, dir: 'esc', path: '../secret' }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json.error)).toContain('invalid path')
  })

  it('rejects unknown routes and non-object bodies', async () => {
    const resolve = workspaceCwdResolver([workspace], workspace)
    const unknown = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/none', 'GET') as never, unknown.res as never)
    expect(unknown.status).toBe(404)
    const bad = responseDouble()
    const req = {
      url: '/latex/write',
      method: 'POST',
      on(event: 'data' | 'end', fn: (chunk?: Buffer) => void) {
        if (event === 'data') fn(Buffer.from('[]'))
        if (event === 'end') fn()
      },
    }
    await handleLatexRequest(resolve, ctxStub, req as never, bad.res as never)
    expect(bad.status).toBe(500)
  })

  it('cleans generated artifacts only', async () => {
    const dir = await makeProject('clean', 'main.tex', MAIN_TEX)
    await writeFile(join(dir, 'main.aux'), 'junk\n')
    await writeFile(join(dir, 'main.log'), 'log\n')
    await writeFile(join(dir, 'main.pdf'), 'pdf\n')
    await writeFile(join(dir, 'notes.md'), 'keep me\n')
    const resolve = workspaceCwdResolver([dir], dir)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/clean', 'POST', { cwd: dir }) as never, double.res as never)
    expect(double.status).toBe(200)
    const body = double.json as { removed: number }
    expect(body.removed).toBe(2)
    expect(existsSync(join(dir, 'notes.md'))).toBe(true)
    expect(existsSync(join(dir, 'main.pdf'))).toBe(true)
    expect(existsSync(join(dir, 'main.aux'))).toBe(false)
  })

  it('installs and lists project fonts', async () => {
    const dir = await makeProject('fonts', 'main.tex', MAIN_TEX)
    const resolve = workspaceCwdResolver([dir], dir)
    const install = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/fonts', 'POST', { cwd: dir, op: 'install', name: 'SimHei.ttf', data: Buffer.from('fake-font-bytes').toString('base64') }) as never, install.res as never)
    expect(install.status).toBe(200)
    expect(String(install.json.path)).toBe('fonts/SimHei.ttf')
    const list = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/fonts', 'POST', { cwd: dir, op: 'list' }) as never, list.res as never)
    expect(list.status).toBe(200)
    expect((list.json as { fonts: string[] }).fonts).toContain('SimHei.ttf')
  })

  it('streams an error event when no LLM provider is available', async () => {
    const dir = await makeProject('ai', 'main.tex', MAIN_TEX)
    const resolve = workspaceCwdResolver([dir], dir)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/ai', 'POST', {
      cwd: dir, path: 'main.tex', selection: 'x', instruction: 'fix', token: 'write-1',
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    const failure = double.lines.find(line => line['t'] === 'err')
    expect(String(failure?.['e'])).toContain('no LLM provider')
  })

  it('streams the writing output as NDJSON and reports the final text', async () => {
    const dir = await makeProject('ai-stream', 'main.tex', MAIN_TEX)
    const streamingCtx = {
      llm: {
        listProviders: () => [{ id: 'stub' }],
        listModels: async () => [{ id: 'stub-model', name: 'Stub Model' }],
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', index: 0, text: '\\section{致谢}' }
            yield { type: 'text-delta', index: 0, text: '\n感谢导师。' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }),
      },
    } as never
    const resolve = workspaceCwdResolver([dir], dir)
    const double = responseDouble()
    await handleLatexRequest(resolve, streamingCtx, requestDouble('/latex/ai', 'POST', {
      cwd: dir, path: 'main.tex', instruction: '写致谢', token: 'write-2', history: [],
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(double.lines.filter(line => line['t'] === 'text').map(line => line['x']))
      .toEqual(['\\section{致谢}', '\n感谢导师。'])
    expect(double.lines.find(line => line['t'] === 'done')?.['m']).toBe('\\section{致谢}\n感谢导师。')
  })

  it('lists the writing-assistant model catalog', async () => {
    const ctxWithModels = {
      llm: {
        listProviders: () => [{ id: 'stub' }],
        listModels: async () => [{ id: 'stub-model', name: 'Stub Model' }],
        stream: () => { throw new Error('no stream in the stub') },
      },
    } as never
    const double = responseDouble()
    await handleLatexRequest(
      workspaceCwdResolver([workspace], workspace),
      ctxWithModels,
      requestDouble('/latex/models', 'GET') as never,
      double.res as never,
    )
    expect(double.status).toBe(200)
    expect((double.json as { models: unknown[] }).models).toEqual([
      { provider: 'stub', model: 'stub-model', name: 'Stub Model' },
    ])
  })

  it('routes a provider-qualified model hint to that provider', async () => {
    const dir = await makeProject('ai-route', 'main.tex', MAIN_TEX)
    const calls: string[] = []
    const twoProviderCtx = {
      llm: {
        listProviders: () => [{ id: 'official' }, { id: 'mirror' }],
        listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek-Flash' }],
        stream: (options: { provider: string }) => {
          calls.push(options.provider)
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'text-delta', index: 0, text: 'ok' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        },
      },
    } as never
    const resolve = workspaceCwdResolver([dir], dir)
    const qualified = responseDouble()
    await handleLatexRequest(resolve, twoProviderCtx, requestDouble('/latex/ai', 'POST', {
      cwd: dir, path: 'main.tex', instruction: '写', token: 'route-1', model: 'mirror/deepseek-flash',
    }) as never, qualified.res as never)
    // A bare id keeps taking the first provider that offers it.
    const bare = responseDouble()
    await handleLatexRequest(resolve, twoProviderCtx, requestDouble('/latex/ai', 'POST', {
      cwd: dir, path: 'main.tex', instruction: '写', token: 'route-2', model: 'deepseek-flash',
    }) as never, bare.res as never)
    expect(calls).toEqual(['mirror', 'official'])
  })

  it('stops a running writing request through the cancel route', async () => {
    const dir = await makeProject('ai-cancel', 'main.tex', MAIN_TEX)
    const slowCtx = {
      llm: {
        listProviders: () => [{ id: 'stub' }],
        listModels: async () => [{ id: 'stub-model', name: 'Stub Model' }],
        stream: (options: { signal?: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', index: 0, text: '部分' }
            await new Promise<void>((resolveWait) => {
              const check = setInterval(() => {
                if (options.signal?.aborted === true) { clearInterval(check); resolveWait() }
              }, 5)
            })
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }),
      },
    } as never
    const resolve = workspaceCwdResolver([dir], dir)
    const double = responseDouble()
    const pending = handleLatexRequest(resolve, slowCtx, requestDouble('/latex/ai', 'POST', {
      cwd: dir, path: 'main.tex', instruction: '写', token: 'write-cancel',
    }) as never, double.res as never)
    // Wait for the first delta instead of a fixed delay: the walk reaches the
    // stream only after reading the file.
    await new Promise<void>((resolveWait) => {
      const check = setInterval(() => {
        if (double.raw.includes('"t":"text"')) { clearInterval(check); resolveWait() }
      }, 5)
    })
    const cancel = responseDouble()
    await handleLatexRequest(resolve, slowCtx, requestDouble('/latex/ai-cancel', 'POST', { token: 'write-cancel' }) as never, cancel.res as never)
    expect(cancel.status).toBe(200)
    await pending
    expect(double.lines.some(line => line['t'] === 'stop')).toBe(true)
  })

  it('404s the pdf route before the first compile', async () => {
    const dir = await makeProject('pdf404', 'main.tex', MAIN_TEX)
    const resolve = workspaceCwdResolver([dir], dir)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble(`/latex/pdf?cwd=${encodeURIComponent(dir)}&dir=.&main=main.tex`, 'GET') as never, double.res as never)
    expect(double.status).toBe(404)
  })
})

describe('missing-reference diagnostics', () => {
  it('names files the project does not provide', async () => {
    const dir = await makeProject('missingref', 'main.tex', MAIN_TEX)
    const log = "! Unable to load picture or PDF file 'fig-keypoints.pdf'.\n"
    expect(explainMissingReferences(log, [], dir)).toContain('fig-keypoints.pdf is not in the project directory')
  })

  it('locates a file the project holds in another directory', async () => {
    const dir = await makeProject('located', 'main.tex', MAIN_TEX)
    await mkdir(join(dir, 'figures'), { recursive: true })
    await writeFile(join(dir, 'figures', 'fig-keypoints.pdf'), '%PDF')
    const log = "File `fig-keypoints.pdf' not found on input line 149."
    expect(explainMissingReferences(log, [], dir)).toContain('figures/fig-keypoints.pdf')
  })

  it('reports a file the mirror bounds left out', async () => {
    const dir = await makeProject('skipped', 'main.tex', MAIN_TEX)
    const log = "! Unable to load picture or PDF file 'big.pdf'."
    expect(explainMissingReferences(log, ['big.pdf'], dir)).toContain('was not mirrored')
  })

  it('points at a workspace copy of a missing file', async () => {
    const dir = await makeProject('elsewhere', 'main.tex', MAIN_TEX)
    const log = "! Unable to load picture or PDF file 'fig-x.png'."
    const elsewhere = new Map([['fig-x.png', 'experiments/results/fig-x.png']])
    expect(explainMissingReferences(log, [], dir, elsewhere)).toContain('experiments/results/fig-x.png')
  })

  it('says nothing when the log names no missing file', async () => {
    const dir = await makeProject('noappendix', 'main.tex', MAIN_TEX)
    expect(explainMissingReferences('! Undefined control sequence.', [], dir)).toBe('')
  })
})

describe('bibtex excerpt', () => {
  it('returns the diagnostic lines instead of the function histogram', () => {
    const log = [
      'This is BibTeX, Version 0.99e',
      'The top-level auxiliary file: paper.aux',
      'The style file: plain.bst',
      "Warning--I didn't find a database entry for \"missing\"",
      'You\'ve used 3 entries,',
      'newline$ -- 15',
      '(There were 2 error messages)',
    ].join('\n')
    const excerpt = extractBibtexExcerpt(log)
    expect(excerpt).toContain("didn't find a database entry")
    expect(excerpt).toContain('2 error messages')
  })

  it('falls back to the header when bibtex reports nothing', () => {
    const log = ['This is BibTeX', 'The style file: plain.bst', 'newline$ -- 15'].join('\n')
    expect(extractBibtexExcerpt(log)).toContain('The style file: plain.bst')
  })
})

describe('log excerpt', () => {
  it('extracts the last error block from a TeX log', () => {
    const log = 'line one\nline two\n! Undefined control sequence.\nl .\\badcommand x\n'
    expect(extractLogExcerpt(log)).toContain('Undefined control sequence')
  })

  it('falls back to the tail when there is no error', () => {
    const log = 'no error here at all\n'
    expect(extractLogExcerpt(log)).toContain('no error here at all')
  })
})

describe('compilation', () => {
  it('compiles a small bilingual document with xelatex', async () => {
    if (xelatexPath === null) {
      console.log('skip: no xelatex available on this machine')
      return
    }
    const dir = await makeProject('compile', 'main.tex', MAIN_TEX)
    const result = await compileProject(dir, 'main.tex')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.size).toBeGreaterThan(0)
    }
    const resolve = workspaceCwdResolver([dir], dir)
    const pdf = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble(`/latex/pdf?cwd=${encodeURIComponent(dir)}&dir=.&main=main.tex`, 'GET') as never, pdf.res as never)
    expect(pdf.status).toBe(200)
    expect(pdf.raw.startsWith('%PDF')).toBe(true)
  }, 180_000)

  it('supplies graphics the project lacks from elsewhere in the workspace', async () => {
    if (xelatexPath === null) {
      console.log('skip: no xelatex available on this machine')
      return
    }
    const project = await makeProject('paper', 'main.tex', String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\includegraphics[width=0.3\textwidth]{ablation_heatmap.png}
\end{document}
`)
    // The figure lives in a sibling experiment tree, not in the paper.
    const results = join(workspace, 'experiments', 'results')
    await mkdir(results, { recursive: true })
    await writeFile(join(results, 'ablation_heatmap.png'), PNG_1PX)
    const result = await compileProject(project, 'main.tex', workspace)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.supplied).toContain('ablation_heatmap.png')
  }, 180_000)

  it('resolves a graphicspath reference without supplying it from the workspace', async () => {
    if (xelatexPath === null) {
      console.log('skip: no xelatex available on this machine')
      return
    }
    const project = await makeProject('graphicspath', 'main.tex', String.raw`\documentclass{article}
\usepackage{graphicx}
\graphicspath{{figs/}}
\begin{document}
\includegraphics[width=0.3\textwidth]{fig-local.png}
\end{document}
`)
    await mkdir(join(project, 'figs'), { recursive: true })
    await writeFile(join(project, 'figs', 'fig-local.png'), PNG_1PX)
    const result = await compileProject(project, 'main.tex', workspace)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.supplied).toEqual([])
  }, 180_000)

  it('compiles a bibliography whose main file sits in a subdirectory', async () => {
    if (xelatexPath === null) {
      console.log('skip: no xelatex available on this machine')
      return
    }
    const dir = await makeProject('bib/paper', 'main.tex', String.raw`\documentclass{article}
\begin{document}
\cite{knuth}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`)
    await writeFile(join(dir, 'refs.bib'), '@book{knuth, author={Knuth}, title={TAOCP}, year={1968}, publisher={AW}}\n')
    const result = await compileProject(dir, 'main.tex', workspace)
    expect(result.ok).toBe(true)
  }, 180_000)

  it('reports the log excerpt on a failed compile', async () => {
    if (xelatexPath === null) {
      console.log('skip: no xelatex available on this machine')
      return
    }
    const dir = await makeProject('bad', 'main.tex', '\\documentclass{article}\n\\begin{document}\n\\badcommand\n\\end{document}\n')
    const result = await compileProject(dir, 'main.tex')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.log).toContain('!')
    }
  }, 180_000)
})
