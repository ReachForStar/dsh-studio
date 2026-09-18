import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const bundlePath = join(packageRoot, 'lib/client.js')
const pdfChunkPath = join(packageRoot, 'lib/client.pdf.js')
const require = createRequire(import.meta.url)
const licenseNames = [
  'LICENSE',
  'cmaps/LICENSE',
  'standard_fonts/LICENSE_FOXIT',
  'standard_fonts/LICENSE_LIBERATION',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS',
] as const

function run(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

function runPnpm(args: string[], cwd: string, timeout: number): string {
  const entrypoint = process.env.npm_execpath
  if (entrypoint !== undefined && entrypoint !== '') {
    return /\.[cm]?js$/iu.test(entrypoint)
      ? run(process.execPath, [entrypoint, ...args], cwd, timeout)
      : run(entrypoint, args, cwd, timeout)
  }
  if (process.platform === 'win32') {
    // pnpm ships as a .cmd shim on Windows and pnpm itself sets no
    // npm_execpath, so the shim is spawned through cmd.exe.
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm', ...args], {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal, result.stderr).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }
  return run('pnpm', args, cwd, timeout)
}

describe('published PDF.js licenses', () => {
  it.skipIf(!existsSync(bundlePath))('keeps every bundled license in the packed PDF chunk', ({ task }) => {
    expect(existsSync(pdfChunkPath)).toBe(true)
    const output = mkdtempSync(join(tmpdir(), 'dsh-document-preview-pack-'))
    try {
      const packed = JSON.parse(runPnpm([
        'pack', '--json', '--pack-destination', output,
      ], packageRoot, task.timeout)) as { filename: string; files: { path: string }[] }
      expect(packed.files.map(file => file.path)).toContain('lib/client.js')
      expect(packed.files.map(file => file.path)).toContain('lib/client.pdf.js')
      expect(packed.files.some(file => file.path.endsWith('pdfjs-NOTICES.txt'))).toBe(false)

      // pnpm reports an absolute filename; bsdtar on Windows parses a
      // drive-letter colon in an archive path as a remote host prefix, so the
      // tarball is addressed by bare name from its own directory.
      const client = run('tar', ['-xOf', basename(packed.filename), 'package/lib/client.js'], dirname(packed.filename), task.timeout)
      const pdf = run('tar', ['-xOf', basename(packed.filename), 'package/lib/client.pdf.js'], dirname(packed.filename), task.timeout)
      expect([...client.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual(['./client.pdf.js'])
      expect(client).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect([...pdf.matchAll(/require\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual([])
      expect(client).not.toContain('//! Bundled PDF.js license notices')
      expect(client).not.toContain('/pdfjs-dist/')
      expect(pdf).toContain('//! Bundled PDF.js license notices')
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
      for (const name of licenseNames) {
        const source = readFileSync(join(pdfRoot, name), 'utf8').trimEnd()
        const commented = [`// ${name}`, '// ', ...source.split('\n').map(line => `// ${line}`)].join('\n')
        expect(pdf, `${name} must be visible in package/lib/client.pdf.js`).toContain(commented)
      }
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
