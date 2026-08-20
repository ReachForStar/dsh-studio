import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  runLoaderSmoke,
} from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/subagent/subagent-pi/',
  import.meta.url,
))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'cordis.yml')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('Pi provider public Loader composition', () => {
  it('loads the opt-in package and foreground tool without starting Pi', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'subagent-pi Loader composition',
      tempDirPrefix: 'dsh-subagent-pi-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: {
        // Loading the optional package must not probe or start a Pi binary.
        PATH: '',
      },
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      providers: ['pi'],
      provider: {
        name: 'pi',
        capabilities: {
          outputSchema: false,
          depthLimit: false,
          toolFilter: false,
          persona: false,
        },
        inheritsParentContext: false,
      },
      tool: {
        name: 'subagent_pi',
        parameterNames: ['description', 'prompt'],
        required: ['description', 'prompt'],
      },
      starts: 0,
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
