/** Driver discovery: a spaced install path is the norm on Windows. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDriver } from '../src/installer.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
})

describe('checkDriver', () => {
  it('reports a command that is not on PATH as not installed', async () => {
    await expect(checkDriver('dsh-driver-that-does-not-exist')).resolves.toEqual({ installed: false, version: null })
  })

  it.skipIf(process.platform !== 'win32')('finds a driver whose install path contains spaces', async () => {
    // Windows resolves `.cmd` shims through a shell, and the shell splits the
    // command at its first space: `C:\Program Files\...` fails unless quoted.
    const root = await mkdtemp(join(tmpdir(), 'cua driver '))
    roots.push(root)
    const shim = join(root, 'cua-driver.cmd')
    await writeFile(shim, '@echo off\r\necho 1.2.3\r\n')

    await expect(checkDriver(shim)).resolves.toEqual({ installed: true, version: '1.2.3' })
  })
})
