/** LaTeX compile pipeline: mirroring, engine passes, bibtex, PDF caching, and
 * missing-reference diagnostics, driven by a scripted TeX distribution. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compileProject, handleLatexRequest } from '../src/latex-service.ts'
import { workspaceCwdResolver } from '../src/git-service.ts'

const ENGINE_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args.includes('--version')) process.exit(0)
const mode = process.env.LATEX_FAKE_MODE ?? 'ok'
const main = args[args.length - 1]
const base = path.basename(main, '.tex')
const dir = path.dirname(main)
fs.mkdirSync(dir, { recursive: true })
const artifact = (extension) => path.join(dir, base + '.' + extension)
const statePath = '.latex-fake-passes'
const passIndex = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0
fs.writeFileSync(statePath, String(passIndex + 1))
const fail = (message, writeLog) => {
  if (writeLog) fs.writeFileSync(artifact('log'), message)
  else process.stderr.write(message)
  process.exit(1)
}
if (mode === 'fail-first') fail('! Fake failure.', true)
if (mode === 'fail-first-silent') fail('fake engine exploded', false)
if (mode === 'fail-missing') fail([
  "! Unable to load picture or PDF file 'fig-workspace.png'.",
  "File \`fig-local.png' not found.",
  "! Unable to load picture or PDF file 'fig-absent.png'.",
].join('\\n') + '\\n', true)
if ((mode === 'fail-later' || mode === 'fail-later-silent' || mode === 'fail-later-no-log') && passIndex >= 1) {
  fail(mode === 'fail-later' ? '! Fake late failure.' : 'fake engine late explosion', mode === 'fail-later')
}
if (mode !== 'fail-later-no-log') fs.writeFileSync(artifact('log'), '')
if (mode !== 'no-aux') fs.writeFileSync(artifact('aux'), mode === 'bib' ? '\\\\relax\\n\\\\bibdata{refs}\\n' : '\\\\relax\\n')
const pdf = artifact('pdf')
if (mode === 'empty-pdf') {
  fs.writeFileSync(pdf, '')
} else {
  fs.writeFileSync(pdf, '%PDF-1.5 fake\\n')
  if (mode === 'huge-pdf') fs.truncateSync(pdf, 20 * 1024 * 1024 + 1)
}
`

const BIBTEX_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('--version')) process.exit(0)
const base = args[0]
const mode = process.env.LATEX_FAKE_BIBTEX ?? 'ok'
const marker = process.env.LATEX_FAKE_MARKER
if (marker !== undefined) fs.appendFileSync(marker, 'bibtex\\n')
if (mode === 'ok') {
  fs.writeFileSync(base + '.blg', 'This is BibTeX')
  process.exit(0)
}
if (mode === 'fail-log') {
  fs.writeFileSync(base + '.blg', 'error message-- missing entry')
  process.exit(1)
}
process.stderr.write('bibtex exploded detail')
process.exit(1)
`

let root: string
let previousPath: string | undefined
let previousMode: string | undefined
let previousBibtexMode: string | undefined
let previousMarker: string | undefined

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-latex-compile-'))
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  for (const [name, source] of [['xelatex', ENGINE_SCRIPT], ['bibtex', BIBTEX_SCRIPT]] as const) {
    const path = join(bin, name)
    await writeFile(path, source)
    await chmod(path, 0o755)
  }
  previousPath = process.env.PATH
  previousMode = process.env.LATEX_FAKE_MODE
  previousBibtexMode = process.env.LATEX_FAKE_BIBTEX
  previousMarker = process.env.LATEX_FAKE_MARKER
  process.env.PATH = `${bin}:${previousPath ?? ''}`
})

afterAll(async () => {
  setEnv('PATH', previousPath)
  setEnv('LATEX_FAKE_MODE', previousMode)
  setEnv('LATEX_FAKE_BIBTEX', previousBibtexMode)
  setEnv('LATEX_FAKE_MARKER', previousMarker)
  await rm(root, { recursive: true, force: true })
})

/** Set or clear a process environment value. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

/** Run a body with the scripted engine modes. */
async function withEngine<T>(
  mode: string,
  body: () => Promise<T>,
  options: { bibtex?: string; marker?: string } = {},
): Promise<T> {
  setEnv('LATEX_FAKE_MODE', mode)
  setEnv('LATEX_FAKE_BIBTEX', options.bibtex)
  setEnv('LATEX_FAKE_MARKER', options.marker)
  try {
    return await body()
  } finally {
    setEnv('LATEX_FAKE_MODE', previousMode)
    setEnv('LATEX_FAKE_BIBTEX', previousBibtexMode)
    setEnv('LATEX_FAKE_MARKER', previousMarker)
  }
}

/** Create a project directory holding one main file. */
async function makeProject(name: string, main = 'main.tex'): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, main), '% main\n')
  return dir
}

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
  }
}

/** Minimal request double: URL + method, no body. */
function requestDouble(path: string, method: string) {
  return {
    url: path,
    method,
    on(event: 'data' | 'end' | 'error', fn: (chunk?: Buffer) => void) {
      if (event === 'end') fn()
    },
  }
}

const ctxStub = {
  llm: {
    listProviders: () => [],
    listModels: async () => [],
    stream: () => { throw new Error('no stream in the stub') },
  },
} as never

describe('compile pipeline', () => {
  it('compiles a document and caches the PDF for the pdf route', async () => {
    const project = await makeProject('ok')
    await withEngine('ok', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.size).toBeGreaterThan(0)
        expect(result.supplied).toEqual([])
      }
    })
    const double = responseDouble()
    await handleLatexRequest(
      workspaceCwdResolver([project], project),
      ctxStub,
      requestDouble(`/latex/pdf?cwd=${encodeURIComponent(project)}&dir=.&main=main.tex`, 'GET') as never,
      double.res as never,
    )
    expect(double.status).toBe(200)
    expect(double.raw.startsWith('%PDF')).toBe(true)
  })

  it('reports the log excerpt when the first pass fails', async () => {
    const project = await makeProject('fail-first')
    await withEngine('fail-first', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.log).toContain('! Fake failure.')
    })
  })

  it('falls back to the command output when the first pass leaves no log', async () => {
    const project = await makeProject('fail-first-silent')
    await withEngine('fail-first-silent', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.log).toContain('fake engine exploded')
    })
  })

  it('runs bibtex when the aux names a database', async () => {
    const project = await makeProject('bib')
    const marker = join(project, 'bibtex-ran.txt')
    await withEngine('bib', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(true)
    }, { marker })
    expect(await readFile(marker, 'utf8')).toContain('bibtex')
  })

  it('reports the bibtex log excerpt when bibtex fails', async () => {
    const project = await makeProject('bib-fail')
    await withEngine('bib', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.log).toContain('error message')
    }, { bibtex: 'fail-log' })
  })

  it('falls back to bibtex output when no bibtex log was written', async () => {
    const project = await makeProject('bib-silent')
    await withEngine('bib', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.log).toContain('bibtex exploded detail')
    }, { bibtex: 'fail-silent' })
  })

  it('reports a later pass failure with its log', async () => {
    const project = await makeProject('late-fail')
    await withEngine('fail-later', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.log).toContain('! Fake late failure.')
    })
  })

  it('falls back to the command output when a later pass leaves no log', async () => {
    const project = await makeProject('late-fail-silent')
    await withEngine('fail-later-silent', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.log).toContain('fake engine late explosion')
    })
  })

  it('falls back to the command output when a later pass has no log file at all', async () => {
    const project = await makeProject('late-fail-no-log')
    await withEngine('fail-later-no-log', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.log).toContain('fake engine late explosion')
    })
  })

  it('compiles without bibtex when the first pass writes no aux file', async () => {
    const project = await makeProject('no-aux')
    await withEngine('no-aux', async () => {
      await expect(compileProject(project, 'main.tex')).resolves.toMatchObject({ ok: true })
    })
  })

  it('reports an empty PDF', async () => {
    const project = await makeProject('empty-pdf')
    await withEngine('empty-pdf', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.log).toContain('empty PDF produced')
    })
  })

  it('reports a PDF above the size bound', async () => {
    const project = await makeProject('huge-pdf')
    await withEngine('huge-pdf', async () => {
      const result = await compileProject(project, 'main.tex')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.log).toContain('PDF exceeds 20 MiB')
    })
  }, 30_000)

  it('skips the workspace graphics scan for an empty workspace root', async () => {
    const project = await makeProject('empty-root')
    await withEngine('ok', async () => {
      const result = await compileProject(project, 'main.tex', '')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.supplied).toEqual([])
    })
  })

  it('does not scan the workspace when an empty root reports a failure', async () => {
    const project = await makeProject('empty-root-fail')
    await withEngine('fail-first', async () => {
      const result = await compileProject(project, 'main.tex', '')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.log).toContain('! Fake failure.')
    })
  })

  it('diagnoses references held by the project, by the workspace, or nowhere', async () => {
    const project = await makeProject('missing-refs')
    const workspace = join(root, 'missing-refs-workspace')
    await mkdir(join(project, 'figures'), { recursive: true })
    await mkdir(join(workspace, 'results'), { recursive: true })
    await writeFile(join(project, 'figures', 'fig-local.png'), 'png')
    await writeFile(join(workspace, 'results', 'fig-workspace.png'), 'png')
    await withEngine('fail-missing', async () => {
      const result = await compileProject(project, 'main.tex', workspace)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.log).toContain('fig-workspace.png is outside the project; the workspace holds it at results/fig-workspace.png')
        expect(result.log).toContain('fig-local.png is in the project at figures/fig-local.png')
        expect(result.log).toContain('fig-absent.png is not in the project directory')
      }
    })
  })

  it('rejects a second compile of the same project while one is running', async () => {
    const project = await makeProject('concurrent')
    await withEngine('ok', async () => {
      const first = compileProject(project, 'main.tex')
      await expect(compileProject(project, 'main.tex')).rejects.toThrow('already running')
      await expect(first).resolves.toMatchObject({ ok: true })
    })
  })

  it('keeps only the ten most recent cached PDFs', async () => {
    const project = await makeProject('eviction')
    await withEngine('ok', async () => {
      for (let index = 0; index < 11; index += 1) {
        await expect(compileProject(project, `m${index}.tex`)).resolves.toMatchObject({ ok: true })
      }
    })
    const resolve = () => project
    const evicted = responseDouble()
    await handleLatexRequest(
      resolve,
      ctxStub,
      requestDouble(`/latex/pdf?cwd=${encodeURIComponent(project)}&dir=.&main=m0.tex`, 'GET') as never,
      evicted.res as never,
    )
    expect(evicted.status).toBe(404)
    const kept = responseDouble()
    await handleLatexRequest(
      resolve,
      ctxStub,
      requestDouble(`/latex/pdf?cwd=${encodeURIComponent(project)}&dir=.&main=m10.tex`, 'GET') as never,
      kept.res as never,
    )
    expect(kept.status).toBe(200)
  }, 60_000)
})
