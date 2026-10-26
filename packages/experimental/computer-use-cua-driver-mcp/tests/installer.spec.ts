/** Driver discovery: PATH, the installers' own locations, and spaced Windows install paths. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDriver, driverCandidates, resolveDriverExecutables } from '../src/installer.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
})

describe('checkDriver', () => {
  it('reports an entirely absent driver as not installed', async () => {
    // An absolute path outside every install location is the only case where a
    // machine that already has the driver still reports absence.
    await expect(checkDriver('/nonexistent/cua-driver-that-does-not-exist')).resolves.toEqual({
      installed: false, version: null, path: null,
    })
  })

  it('probes the configured command first, then the installers’ own locations', async () => {
    const candidates = await resolveDriverExecutables('cua-driver')
    expect(candidates[0]).toBe('cua-driver')
    expect(candidates.slice(1)).toEqual(driverCandidates().filter(candidate => candidate !== undefined))
  })

  it('leaves an absolute configured path alone', async () => {
    await expect(resolveDriverExecutables('/opt/cua/cua-driver')).resolves.toEqual(['/opt/cua/cua-driver'])
  })

  it('names the install locations of this platform', () => {
    const candidates = driverCandidates()
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.some(candidate => candidate.includes('.cua-driver'))).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('finds a driver whose install path contains spaces', async () => {
    // Windows resolves `.cmd` shims through a shell, and the shell splits the
    // command at its first space: `C:\Program Files\...` fails unless quoted.
    const root = await mkdtemp(join(tmpdir(), 'cua driver '))
    roots.push(root)
    const shim = join(root, 'cua-driver.cmd')
    await writeFile(shim, '@echo off\r\necho 1.2.3\r\n')

    await expect(checkDriver(shim)).resolves.toEqual({ installed: true, version: '1.2.3', path: shim })
  })

  it.skipIf(process.platform === 'win32')('reads the version from an executable without a PATH entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cua-driver-'))
    roots.push(root)
    const executable = join(root, 'cua-driver')
    await writeFile(executable, '#!/bin/sh\necho "cua-driver 9.8.7"\n', { mode: 0o755 })
    await mkdir(join(root, 'empty'), { recursive: true })

    await expect(checkDriver(executable)).resolves.toEqual({ installed: true, version: '9.8.7', path: executable })
  })
})
