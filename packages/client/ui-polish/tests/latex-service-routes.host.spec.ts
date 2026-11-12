/** LaTeX panel routes: validation failures, compiled-PDF serving, artifact
 * cleanup, font and package installation, and the streaming writing routes. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { handleLatexRequest } from '../src/latex-service.ts'
import { workspaceCwdResolver } from '../src/git-service.ts'

let workspace: string
let fakeBin: string
let previousPath: string | undefined

const ENGINE_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args.includes('--version')) process.exit(0)
const main = args[args.length - 1]
const base = path.basename(main, '.tex')
const dir = path.dirname(main)
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, base + '.log'), '')
fs.writeFileSync(path.join(dir, base + '.aux'), '\\\\relax\\n')
fs.writeFileSync(path.join(dir, base + '.pdf'), '%PDF-1.5 fake\\n')
`

const TLMGR_SCRIPT = `#!/usr/bin/env node
if (process.argv.includes('--version')) process.exit(0)
if ((process.env.LATEX_FAKE_TLMGR ?? 'ok') === 'fail') {
  process.stderr.write('tlmgr: package unavailable')
  process.exit(1)
}
process.stdout.write('installed ctex')
`

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-latex-routes-'))
  fakeBin = join(workspace, 'bin')
  await mkdir(fakeBin, { recursive: true })
  for (const [name, source] of [['xelatex', ENGINE_SCRIPT], ['tlmgr', TLMGR_SCRIPT]] as const) {
    const path = join(fakeBin, name)
    await writeFile(path, source)
    await chmod(path, 0o755)
  }
  previousPath = process.env.PATH
})

afterAll(async () => {
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  await rm(workspace, { recursive: true, force: true })
})

/** Run a body with PATH starting at the fake TeX distribution. */
async function withFakeBin<T>(body: () => Promise<T>): Promise<T> {
  process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
  try {
    return await body()
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
}

/** A fresh module instance, so the engine cache starts empty. */
async function freshService(): Promise<typeof import('../src/latex-service.ts')> {
  vi.resetModules()
  return import('../src/latex-service.ts')
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
    get json(): Record<string, unknown> { return JSON.parse(body) as Record<string, unknown> },
    get lines(): Record<string, unknown>[] {
      return body.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    },
  }
}

/** A response whose first `end` fails after the headers went out. */
function breakingResponse() {
  let statusCode = 0
  let ended = false
  let ends = 0
  return {
    res: {
      writeHead(status: number) { statusCode = status },
      write() {},
      end() {
        if (ends === 0) {
          ends += 1
          throw new Error('socket closed')
        }
        ended = true
      },
      get writableEnded() { return ended },
      get headersSent() { return statusCode > 0 },
    },
    get ended(): boolean { return ended },
  }
}

/** A response that marks itself finished and then reports a write failure. */
function finishingResponse() {
  let statusCode = 0
  let ended = false
  return {
    res: {
      writeHead(status: number) { statusCode = status },
      write() {},
      end() {
        ended = true
        throw new Error('write after end')
      },
      get writableEnded() { return ended },
      get headersSent() { return statusCode > 0 },
    },
    get ended(): boolean { return ended },
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

/** Poll until the double shows the expected stream output. */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the expected condition never appeared')
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 5))
  }
}

const ctxStub = {
  llm: {
    listProviders: () => [],
    listModels: async () => [],
    stream: () => { throw new Error('no stream in the stub') },
  },
} as never

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

const TEXT = (text: string, index = 0) => ({ type: 'text-delta' as const, index, text })
const FINISH = () => ({ type: 'finish' as const, reason: { kind: 'stop' as const } })

/** One scripted stream emitting the given chunks. */
function emit(chunks: readonly unknown[]): () => AsyncIterable<unknown> {
  return async function* () {
    for (const chunk of chunks) yield chunk
  }
}

/** Create a project directory holding one main file. */
async function makeProject(name: string): Promise<string> {
  const dir = join(workspace, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'main.tex'), '% main\n')
  return dir
}

describe('discovery and file routes', () => {
  it('lists projects under a workspace', async () => {
    const project = await makeProject('projects-route')
    const resolve = workspaceCwdResolver([workspace], workspace)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/projects', 'POST', { cwd: workspace }) as never, double.res as never)
    expect(double.status).toBe(200)
    const projects = double.json['projects'] as { path: string }[]
    expect(projects.some(entry => entry.path === 'projects-route')).toBe(true)
    expect(existsSync(join(project, 'main.tex'))).toBe(true)
  })

  it('lists the workspace root when the project directory is omitted', async () => {
    await makeProject('list-default')
    const resolve = workspaceCwdResolver([workspace], workspace)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/list', 'POST', { cwd: workspace }) as never, double.res as never)
    expect(double.status).toBe(200)
    const files = double.json['files'] as { path: string }[]
    expect(files.some(entry => entry.path === 'list-default')).toBe(true)
  })

  it('reads a file from the workspace root when the project directory is omitted', async () => {
    await makeProject('read-default')
    const resolve = workspaceCwdResolver([workspace], workspace)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/read', 'POST', {
      cwd: workspace, path: 'read-default/main.tex',
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(String(double.json['content'])).toBe('% main\n')
  })

  it('refuses to read a file above the editable size bound', async () => {
    const project = await makeProject('read-huge')
    await writeFile(join(project, 'large.tex'), 'x'.repeat(2 * 1024 * 1024 + 1))
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/read', 'POST', {
      cwd: project, path: 'large.tex',
    }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toContain('file too large to edit')
  })

  it('writes a file relative to the workspace root when the project directory is omitted', async () => {
    await makeProject('write-default')
    const resolve = workspaceCwdResolver([workspace], workspace)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/write', 'POST', {
      cwd: workspace, path: 'write-default/added.tex', content: '% added\n',
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(existsSync(join(workspace, 'write-default', 'added.tex'))).toBe(true)
  })

  it('refuses to save a file above the editable size bound', async () => {
    const project = await makeProject('write-huge')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/write', 'POST', {
      cwd: project, path: 'large.tex', content: 'x'.repeat(2 * 1024 * 1024 + 1),
    }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toContain('file too large to save')
  })
})

describe('compile and pdf routes', () => {
  it('compiles through the route with the default project directory', async () => {
    const project = await makeProject('compile-route')
    await withFakeBin(async () => {
      const svc = await freshService()
      const double = responseDouble()
      await svc.handleLatexRequest(workspaceCwdResolver([project], project), ctxStub, requestDouble('/latex/compile', 'POST', {
        cwd: project, main: 'main.tex',
      }) as never, double.res as never)
      expect(double.status).toBe(200)
      expect(double.json['ok']).toBe(true)
    })
  })

  it('rejects a main file that is not LaTeX source', async () => {
    const project = await makeProject('compile-bad-main')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/compile', 'POST', {
      cwd: project, main: 'main.pdf',
    }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toContain('main must be a .tex file')
  })

  it('404s the pdf route without any query parameters', async () => {
    const double = responseDouble()
    await handleLatexRequest(workspaceCwdResolver([workspace], workspace), ctxStub, requestDouble('/latex/pdf', 'GET') as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toContain('/latex/pdf needs main')
  }, 10_000)

  it('ends a response that failed after its headers were sent', async () => {
    const project = await makeProject('pdf-broken-response')
    await withFakeBin(async () => {
      const svc = await freshService()
      const compiled = await svc.compileProject(project, 'main.tex')
      expect(compiled.ok).toBe(true)
      const broken = breakingResponse()
      await svc.handleLatexRequest(
        workspaceCwdResolver([project], project),
        ctxStub,
        requestDouble(`/latex/pdf?cwd=${encodeURIComponent(project)}&dir=.&main=main.tex`, 'GET') as never,
        broken.res as never,
      )
      expect(broken.ended).toBe(true)
    })
  })
  it('leaves a response alone when the failure arrives after it finished', async () => {
    const project = await makeProject('pdf-finished-response')
    await withFakeBin(async () => {
      const svc = await freshService()
      const compiled = await svc.compileProject(project, 'main.tex')
      expect(compiled.ok).toBe(true)
      const finished = finishingResponse()
      await svc.handleLatexRequest(
        workspaceCwdResolver([project], project),
        ctxStub,
        requestDouble(`/latex/pdf?cwd=${encodeURIComponent(project)}&dir=.&main=main.tex`, 'GET') as never,
        finished.res as never,
      )
      expect(finished.ended).toBe(true)
    })
  })
})

describe('clean route', () => {
  it('removes build artifacts in nested directories and skips tool directories', async () => {
    const project = await makeProject('clean-nested')
    await mkdir(join(project, 'sections'), { recursive: true })
    await mkdir(join(project, 'node_modules'), { recursive: true })
    await writeFile(join(project, 'sections', 'intro.aux'), 'junk\n')
    await writeFile(join(project, 'node_modules', 'kept.aux'), 'keep\n')
    await writeFile(join(project, 'README'), 'no extension\n')
    await writeFile(join(project, 'main.log'), 'log\n')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/clean', 'POST', { cwd: project }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(double.json['removed']).toBe(2)
    expect(existsSync(join(project, 'sections', 'intro.aux'))).toBe(false)
    expect(existsSync(join(project, 'node_modules', 'kept.aux'))).toBe(true)
  })

  it('reports no removal when the project directory cannot be read', async () => {
    const project = await makeProject('clean-unreadable')
    await writeFile(join(project, 'not-a-directory'), 'x')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/clean', 'POST', {
      cwd: project, dir: 'not-a-directory',
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(double.json['removed']).toBe(0)
  })
})

describe('fonts route', () => {
  it('lists an empty font set when the project has no fonts directory', async () => {
    const project = await makeProject('fonts-empty')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/fonts', 'POST', {
      cwd: project, op: 'list',
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(double.json['fonts']).toEqual([])
  })

  it('rejects install requests with an unsupported extension', async () => {
    const project = await makeProject('fonts-ext')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/fonts', 'POST', {
      cwd: project, op: 'install', name: 'font.txt', data: 'AA==',
    }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toContain('font must be a .ttf/.otf/.otc/.ttc file')
  })

  it('rejects install requests whose font name escapes the fonts directory', async () => {
    const project = await makeProject('fonts-name')
    const resolve = workspaceCwdResolver([project], project)
    for (const name of ['../evil.ttf', 'dir/evil.ttf', '\\evil.ttf']) {
      const double = responseDouble()
      await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/fonts', 'POST', {
        cwd: project, op: 'install', name, data: 'AA==',
      }) as never, double.res as never)
      expect(double.status).toBe(500)
      expect(String(double.json['error'])).toContain('invalid font name')
    }
  })

  it('rejects install requests whose data decodes to nothing', async () => {
    const project = await makeProject('fonts-empty-data')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/fonts', 'POST', {
      cwd: project, op: 'install', name: 'empty.ttf', data: '!!!!',
    }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toContain('font data is empty or exceeds 20 MiB')
  })

  it('rejects install requests whose data exceeds the font bound', async () => {
    const project = await makeProject('fonts-huge-data')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    const oversized = 'A'.repeat(Math.ceil((20 * 1024 * 1024 + 1) / 3) * 4)
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/fonts', 'POST', {
      cwd: project, op: 'install', name: 'huge.ttf', data: oversized,
    }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toContain('font data is empty or exceeds 20 MiB')
  }, 30_000)

  it('rejects an unknown fonts operation', async () => {
    const project = await makeProject('fonts-op')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/fonts', 'POST', {
      cwd: project, op: 'remove',
    }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toContain('fonts op must be list, install, or install-package')
  })
})

describe('package installation route', () => {
  it('rejects an invalid package name', async () => {
    const project = await makeProject('package-name')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/fonts', 'POST', {
      cwd: project, op: 'install-package', name: 'ctex package',
    }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toContain('invalid tlmgr package name')
  })

  it('installs a package through tlmgr', async () => {
    const project = await makeProject('package-ok')
    await withFakeBin(async () => {
      const svc = await freshService()
      const double = responseDouble()
      await svc.handleLatexRequest(workspaceCwdResolver([project], project), ctxStub, requestDouble('/latex/fonts', 'POST', {
        cwd: project, op: 'install-package', name: 'ctex',
      }) as never, double.res as never)
      expect(double.status).toBe(200)
      expect(double.json['ok']).toBe(true)
      expect(String(double.json['log'])).toContain('installed ctex')
    })
  })

  it('reports a failing tlmgr install with its output', async () => {
    const project = await makeProject('package-fail')
    await withFakeBin(async () => {
      const previous = process.env.LATEX_FAKE_TLMGR
      process.env.LATEX_FAKE_TLMGR = 'fail'
      try {
        const svc = await freshService()
        const double = responseDouble()
        await svc.handleLatexRequest(workspaceCwdResolver([project], project), ctxStub, requestDouble('/latex/fonts', 'POST', {
          cwd: project, op: 'install-package', name: 'ctex',
        }) as never, double.res as never)
        expect(double.status).toBe(500)
        expect(String(double.json['error'])).toContain('tlmgr install ctex failed')
        expect(String(double.json['error'])).toContain('package unavailable')
      } finally {
        if (previous === undefined) delete process.env.LATEX_FAKE_TLMGR
        else process.env.LATEX_FAKE_TLMGR = previous
      }
    })
  })

  it('reports an install-package request when tlmgr is absent', async () => {
    const project = await makeProject('package-absent')
    const previous = process.env.PATH
    process.env.PATH = ''
    try {
      const svc = await freshService()
      const double = responseDouble()
      await svc.handleLatexRequest(workspaceCwdResolver([project], project), ctxStub, requestDouble('/latex/fonts', 'POST', {
        cwd: project, op: 'install-package', name: 'ctex',
      }) as never, double.res as never)
      expect(double.status).toBe(500)
      expect(String(double.json['error'])).toContain('tlmgr not found')
    } finally {
      process.env.PATH = previous
    }
  })
})

describe('writing route', () => {
  it('streams a short conversation with a selection', async () => {
    const project = await makeProject('write-history')
    const seen: unknown[] = []
    const ctx = fakeContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, {
      gateway: emit([TEXT('answer'), FINISH()]),
    }, seen)
    const double = responseDouble()
    await handleLatexRequest(workspaceCwdResolver([project], project), ctx, requestDouble('/latex/ai', 'POST', {
      cwd: project,
      path: 'main.tex',
      selection: 'selected text',
      instruction: 'improve',
      token: 'history-1',
      history: [
        { role: 'user', text: 'earlier question' },
        { role: 'assistant', text: 'earlier answer' },
        { role: 'user', text: 'later question' },
      ],
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(double.lines.find(line => line['t'] === 'done')?.['m']).toBe('answer')
    const options = seen[0] as { messages: { role: string; content: { text?: string }[] }[] }
    expect(options.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'user'])
    expect(options.messages[0]?.content[0]?.text).toContain('LaTeX selection')
    expect(options.messages[3]?.content[0]?.text).toBe('improve')
  })

  it('sends the file content when the route carries no selection', async () => {
    await makeProject('write-default-dir')
    const seen: unknown[] = []
    const ctx = fakeContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, {
      gateway: emit([TEXT('done'), FINISH()]),
    }, seen)
    const double = responseDouble()
    await handleLatexRequest(workspaceCwdResolver([workspace], workspace), ctx, requestDouble('/latex/ai', 'POST', {
      cwd: workspace, path: 'write-default-dir/main.tex', instruction: 'rewrite', token: 'default-1',
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    const options = seen[0] as { messages: { content: { text?: string }[] }[] }
    expect(options.messages[0]?.content[0]?.text).toContain('LaTeX source:\n% main')
  })

  it('rejects a path that escapes the project', async () => {
    const project = await makeProject('write-escape')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/ai', 'POST', {
      cwd: project, path: '../outside.tex', instruction: 'x', token: 'escape-1',
    }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toContain('path escapes the project')
  })

  it('treats a missing file as empty content', async () => {
    const project = await makeProject('write-missing-file')
    const seen: unknown[] = []
    const ctx = fakeContext({ gateway: [{ id: 'm1', name: 'Model 1' }] }, {
      gateway: emit([TEXT('ok'), FINISH()]),
    }, seen)
    const double = responseDouble()
    await handleLatexRequest(workspaceCwdResolver([project], project), ctx, requestDouble('/latex/ai', 'POST', {
      cwd: project, path: 'not-created-yet.tex', instruction: 'draft it', token: 'missing-1',
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    const options = seen[0] as { messages: { content: { text?: string }[] }[] }
    expect(options.messages[0]?.content[0]?.text).toContain('LaTeX source:\n\n\nInstruction')
  })

  it('streams an error event for a non-Error failure', async () => {
    const project = await makeProject('write-non-error')
    const ctx = {
      llm: {
        listProviders: () => { throw 'provider registry exploded' },
        listModels: async () => [],
        stream: () => { throw new Error('unused') },
      },
    } as never
    const double = responseDouble()
    await handleLatexRequest(workspaceCwdResolver([project], project), ctx, requestDouble('/latex/ai', 'POST', {
      cwd: project, path: 'main.tex', instruction: 'x', token: 'non-error-1',
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(double.lines.find(line => line['t'] === 'err')?.['e']).toBe('provider registry exploded')
  })

  it('reports a stopped stream when the request is aborted mid-flight', async () => {
    const project = await makeProject('write-abort-failure')
    const ctx = {
      llm: {
        listProviders: () => [{ id: 'gateway' }],
        listModels: async () => [{ id: 'm1', name: 'Model 1' }],
        stream: (options: { signal?: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            yield TEXT('partial')
            await new Promise<void>((resolveWait) => {
              const check = setInterval(() => {
                if (options.signal?.aborted === true) { clearInterval(check); resolveWait() }
              }, 5)
            })
            throw new Error('aborted stream')
          },
        }),
      },
    } as never
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    const pending = handleLatexRequest(resolve, ctx, requestDouble('/latex/ai', 'POST', {
      cwd: project, path: 'main.tex', instruction: 'x', token: 'abort-failure-1',
    }) as never, double.res as never)
    await waitFor(() => double.raw.includes('"t":"text"'))
    const cancel = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/ai-cancel', 'POST', { token: 'abort-failure-1' }) as never, cancel.res as never)
    await pending
    expect(double.lines.some(line => line['t'] === 'stop')).toBe(true)
  })

  it('skips deltas once the response has ended', async () => {
    const project = await makeProject('write-ended')
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const ctx = {
      llm: {
        listProviders: () => [{ id: 'gateway' }],
        listModels: async () => [{ id: 'm1', name: 'Model 1' }],
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield TEXT('first')
            await gate
            yield TEXT('second')
            yield FINISH()
          },
        }),
      },
    } as never
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    const pending = handleLatexRequest(resolve, ctx, requestDouble('/latex/ai', 'POST', {
      cwd: project, path: 'main.tex', instruction: 'x', token: 'ended-1',
    }) as never, double.res as never)
    await waitFor(() => double.raw.includes('"t":"text"'))
    double.res.end()
    release()
    await pending
    expect(double.lines.filter(line => line['t'] === 'text').map(line => line['x'])).toEqual(['first'])
  })

  it('accepts a cancel for an unknown token', async () => {
    const double = responseDouble()
    await handleLatexRequest(workspaceCwdResolver([workspace], workspace), ctxStub, requestDouble('/latex/ai-cancel', 'POST', { token: 'never-started' }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(double.json['ok']).toBe(true)
  })
})

describe('request plumbing', () => {
  it('defaults a missing URL and method to a GET of the root path', async () => {
    const double = responseDouble()
    await handleLatexRequest(
      workspaceCwdResolver([workspace], workspace),
      ctxStub,
      { on(event: 'data' | 'end', fn: (chunk?: Buffer) => void) { if (event === 'end') fn() } } as never,
      double.res as never,
    )
    expect(double.status).toBe(404)
    expect(String(double.json['error'])).toContain('unknown route GET /')
  })

  it('answers 404 for a known path with the wrong method', async () => {
    const double = responseDouble()
    await handleLatexRequest(workspaceCwdResolver([workspace], workspace), ctxStub, requestDouble('/latex/projects', 'GET') as never, double.res as never)
    expect(double.status).toBe(404)
  })

  it('reports a non-Error thrown by the workspace resolver', async () => {
    const resolve = () => { throw 'resolver exploded' }
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/projects', 'POST', { cwd: 'x' }) as never, double.res as never)
    expect(double.status).toBe(500)
    expect(String(double.json['error'])).toBe('resolver exploded')
  })

  it('reads a file whose content is the empty string', async () => {
    const project = await makeProject('read-empty')
    await writeFile(join(project, 'empty.tex'), '')
    const resolve = workspaceCwdResolver([project], project)
    const double = responseDouble()
    await handleLatexRequest(resolve, ctxStub, requestDouble('/latex/read', 'POST', {
      cwd: project, path: 'empty.tex',
    }) as never, double.res as never)
    expect(double.status).toBe(200)
    expect(double.json['content']).toBe('')
  })
})
