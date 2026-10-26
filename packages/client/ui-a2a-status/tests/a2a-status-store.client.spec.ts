import { describe, expect, it } from 'vitest'

import type { A2AStatus } from '@reachforstar/dsh-a2a-status/types'

import { A2aStatusStore, messageOf } from '../src/client/a2a-status-store.ts'
import type { A2aStatusRemoteFace } from '../src/client/a2a-status-store.ts'

/** 一份就绪快照，供用例按下标改字段。 */
function snapshot(patch: Partial<A2AStatus> = {}): A2AStatus {
  return {
    hostRunning: true,
    hostPort: 9310,
    kafkaPhase: 'ready',
    kafkaReady: true,
    kafkaBrokers: ['127.0.0.1:9092'],
    kafkaFailure: null,
    kafkaDiagnostic: '',
    ...patch,
  }
}

/** 记录调用并按需返回的 Remote 替身。 */
function remoteOf(...results: (A2AStatus | Error)[]): A2aStatusRemoteFace & { calls: number } {
  const state = { calls: 0 }
  return {
    get calls() { return state.calls },
    async status() {
      const result = results[Math.min(state.calls, results.length - 1)] ?? snapshot()
      state.calls += 1
      if (result instanceof Error) throw result
      return result
    },
  }
}

describe('messageOf', () => {
  it('Error 取消息，其他值转字符串', () => {
    expect(messageOf(new Error('坏了'))).toBe('坏了')
    expect(messageOf('纯文本')).toBe('纯文本')
    expect(messageOf(42)).toBe('42')
  })
})

describe('A2aStatusStore', () => {
  it('初始为 idle 且未就绪', () => {
    const store = new A2aStatusStore(remoteOf(snapshot()))
    expect(store.store.getSnapshot()).toMatchObject({ status: 'idle', available: false, kafkaFailure: null })
  })

  it('成功查询后写入全部字段', async () => {
    const store = new A2aStatusStore(remoteOf(snapshot({
      kafkaPhase: 'unavailable',
      kafkaReady: false,
      kafkaFailure: 'start-failed',
      kafkaDiagnostic: '退出码 1',
      hostRunning: false,
      hostPort: 0,
    })))
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready',
      error: null,
      available: false,
      hostRunning: false,
      hostPort: 0,
      kafkaPhase: 'unavailable',
      kafkaReady: false,
      kafkaBrokers: ['127.0.0.1:9092'],
      kafkaFailure: 'start-failed',
      kafkaDiagnostic: '退出码 1',
    })
  })

  it('查询失败时记录错误文本并置为不可用', async () => {
    const store = new A2aStatusStore(remoteOf(new Error('a2a.status failed: Boom: 挂了')))
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'a2a.status failed: Boom: 挂了',
      available: false,
    })
  })

  it('查询抛非 Error 值时同样记录文本', async () => {
    const remote: A2aStatusRemoteFace = { status: async () => { throw '字符串失败' } }
    const store = new A2aStatusStore(remote)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: '字符串失败' })
  })

  it('加载中会先清空上一次的错误', async () => {
    let release: (value: A2AStatus) => void = () => {}
    const remote: A2aStatusRemoteFace = { status: async () => new Promise<A2AStatus>((resolve) => { release = resolve }) }
    const store = new A2aStatusStore(remote)
    const pending = store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'loading', error: null })
    release(snapshot())
    await pending
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready' })
  })

  it('后发起的查询覆盖先发起的，先完成者被丢弃', async () => {
    const resolvers: ((value: A2AStatus) => void)[] = []
    const remote: A2aStatusRemoteFace = {
      status: async () => new Promise<A2AStatus>((resolve) => { resolvers.push(resolve) }),
    }
    const store = new A2aStatusStore(remote)
    const first = store.load()
    const second = store.load()
    // 先完成旧代，再完成新代：旧代的写入必须被 generation 检查挡掉。
    resolvers[0]?.(snapshot({ hostRunning: false }))
    await first
    expect(store.store.getSnapshot()).toMatchObject({ status: 'loading' })
    resolvers[1]?.(snapshot({ hostRunning: true }))
    await second
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', hostRunning: true })
  })

  it('过期代的错误也被丢弃', async () => {
    const failures: ((error: Error) => void)[] = []
    const remote: A2aStatusRemoteFace = {
      status: async () => new Promise<A2AStatus>((_resolve, reject) => { failures.push(reject) }),
    }
    const store = new A2aStatusStore(remote)
    const first = store.load()
    const second = store.load()
    failures[0]?.(new Error('旧代失败'))
    await first
    expect(store.store.getSnapshot()).toMatchObject({ status: 'loading' })
    failures[1]?.(new Error('新代失败'))
    await second
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: '新代失败' })
  })

  it('销毁后不再发起查询', async () => {
    const remote = remoteOf(snapshot())
    const store = new A2aStatusStore(remote)
    store.dispose()
    await store.load()
    expect(remote.calls).toBe(0)
    expect(store.store.getSnapshot()).toMatchObject({ status: 'idle' })
  })

  it('销毁会让正在进行的查询结果失效', async () => {
    let release: (value: A2AStatus) => void = () => {}
    const remote: A2aStatusRemoteFace = { status: async () => new Promise<A2AStatus>((resolve) => { release = resolve }) }
    const store = new A2aStatusStore(remote)
    const pending = store.load()
    store.dispose()
    release(snapshot())
    await pending
    expect(store.store.getSnapshot()).toMatchObject({ status: 'loading' })
  })
})
