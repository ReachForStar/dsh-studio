import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadA2ABridgeConfig } from '../src/bridge-config.ts'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** 写一份桥配置文件，返回它的路径。 */
function configFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-a2a-bridge-'))
  dirs.push(dir)
  const path = join(dir, 'config.json')
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

describe('loadA2ABridgeConfig', () => {
  it('未配置路径时报错并指明环境变量', () => {
    expect(() => loadA2ABridgeConfig({ env: {} })).toThrow(/no configuration path; pass one or set A2A_CONFIG/)
  })

  it('读取文件里的 agents / bus / skills 与模型', () => {
    const path = configFile({
      agents: { pi: { port: 1, defaultWorkspace: '/w' }, opencode: { port: 3, defaultWorkspace: '/o' } },
      bus: { bootstrapServers: ['broker:1'], taskTopic: 't', eventTopic: 'e', dlqTopic: 'd', partitions: 2, maxAttempts: 5 },
      piSkillTools: { 'code-dev': [], analysis: [] },
      claudeSkillTools: { 'code-review': [] },
      opencodeSkillAgents: { coding: 'bridge-coding' },
      piModel: 'p/m',
      opencodeModel: 'o/m',
      idleMs: 1000,
      taskTimeoutMs: 2000,
    })
    const config = loadA2ABridgeConfig({ path })
    expect(config.agents).toEqual({
      pi: { port: 1, defaultWorkspace: '/w' },
      // 文件未提到的 agent 保留默认端口
      'claude-code': { port: 9320, defaultWorkspace: '' },
      opencode: { port: 3, defaultWorkspace: '/o' },
    })
    expect(config.bus).toEqual({
      bootstrapServers: ['broker:1'],
      taskTopic: 't',
      eventTopic: 'e',
      dlqTopic: 'd',
      partitions: 2,
      maxAttempts: 5,
    })
    expect(config.skills).toEqual({
      pi: ['code-dev', 'analysis'],
      'claude-code': ['code-review'],
      opencode: ['coding'],
    })
    expect(config.piModel).toBe('p/m')
    expect(config.opencodeModel).toBe('o/m')
    expect(config.idleMs).toBe(1000)
    expect(config.taskTimeoutMs).toBe(2000)
    expect(config.apiKey).toBe('')
  })

  it('文件缺字段时用桥的默认值', () => {
    const config = loadA2ABridgeConfig({ path: configFile({}) })
    expect(config.agents.pi.port).toBe(9310)
    expect(config.bus.bootstrapServers).toEqual(['127.0.0.1:9092'])
    expect(config.bus.taskTopic).toBe('a2a.task')
    expect(config.bus.maxAttempts).toBe(3)
    expect(config.skills.pi).toEqual(['code-dev', 'repo-maintenance', 'analysis'])
    expect(config.skills['claude-code']).toEqual(['code-review', 'coding'])
    expect(config.skills.opencode).toEqual(['code-review', 'analysis', 'coding'])
    expect(config.idleMs).toBe(1_800_000)
    expect(config.taskTimeoutMs).toBe(600_000)
  })

  it('环境变量覆盖路径、密钥、broker 与模型', () => {
    const path = configFile({ bus: { bootstrapServers: ['ignored:1'] } })
    const config = loadA2ABridgeConfig({
      env: {
        A2A_CONFIG: path,
        A2A_API_KEY: 'secret',
        A2A_BUS_BOOTSTRAP: ' a:1 , b:2 ',
        A2A_PI_MODEL: 'env/pi',
        A2A_OC_MODEL: 'env/oc',
      },
    })
    expect(config.apiKey).toBe('secret')
    expect(config.bus.bootstrapServers).toEqual(['a:1', 'b:2'])
    expect(config.piModel).toBe('env/pi')
    expect(config.opencodeModel).toBe('env/oc')
  })

  it('空 broker 列表由文件值接管，非法类型报错', () => {
    const path = configFile({ bus: { bootstrapServers: ['a:1'] } })
    expect(loadA2ABridgeConfig({ path, env: { A2A_BUS_BOOTSTRAP: '' } }).bus.bootstrapServers).toEqual(['a:1'])
    expect(() => loadA2ABridgeConfig({ path: configFile({ bus: { bootstrapServers: 'a:1' } }) }))
      .toThrow(/bus.bootstrapServers must be an array of strings/)
  })

  it('非法 JSON、非对象根与非法 agent 都报错', () => {
    expect(() => loadA2ABridgeConfig({ path: configFile('{ not json') })).toThrow(/is not valid JSON/)
    expect(() => loadA2ABridgeConfig({ path: configFile([]) })).toThrow(/must be an object/)
    expect(() => loadA2ABridgeConfig({ path: configFile({ agents: { pi: 3 } }) }))
      .toThrow(/agents.pi must be an object/)
    expect(() => loadA2ABridgeConfig({ path: configFile({ piSkillTools: 3 }) }))
      .toThrow(/piSkillTools must be an object/)
  })

  it('读取不存在的文件时直接抛出', () => {
    expect(() => loadA2ABridgeConfig({ path: join(tmpdir(), 'dsh-a2a-bridge-missing', 'config.json') }))
      .toThrow(/ENOENT/)
  })
})
