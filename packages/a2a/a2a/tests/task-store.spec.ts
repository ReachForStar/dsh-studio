import { describe, expect, it } from 'vitest'
import { isTerminal, textOf, type TaskState } from '../src/schema.ts'
import { TaskStore } from '../src/task-store.ts'

describe('textOf', () => {
  it('只拼接文本分片', () => {
    expect(textOf(undefined)).toBe('')
    expect(textOf([{ text: 'a' }, { url: 'x' }, { text: 'b' }])).toBe('ab')
    expect(textOf([{}])).toBe('')
  })
})

describe('isTerminal', () => {
  it.each([
    ['TASK_STATE_COMPLETED', true],
    ['TASK_STATE_FAILED', true],
    ['TASK_STATE_CANCELED', true],
    ['TASK_STATE_REJECTED', true],
    ['TASK_STATE_WORKING', false],
    ['TASK_STATE_INPUT_REQUIRED', false],
  ] as const)('%s → %s', (state, terminal) => {
    expect(isTerminal(state as TaskState)).toBe(terminal)
  })
})

describe('TaskStore', () => {
  it('创建任务、按 id 取回、按会话索引', () => {
    const store = new TaskStore()
    const task = store.create('ctx-1', { skill: 'x' })
    expect(store.get(task.id)).toBe(task)
    expect(store.get('missing')).toBeUndefined()
    expect(task).toMatchObject({ contextId: 'ctx-1', metadata: { skill: 'x' } })
    expect(task.status.state).toBe('TASK_STATE_SUBMITTED')
    expect(store.count({ contextId: 'ctx-1' })).toBe(1)
    expect(store.all()).toEqual([task])
    const anonymous = store.create()
    expect(anonymous.contextId).not.toBe('ctx-1')
    expect(anonymous.metadata).toBeUndefined()
  })

  it('按会话与状态筛选，按页截断，默认省略工件字段', () => {
    const store = new TaskStore()
    const first = store.create('ctx-1')
    const second = store.create('ctx-1')
    store.create('ctx-2')
    store.setStatus(first, 'TASK_STATE_COMPLETED')
    // 时间戳在 setStatus 之后拨，避免被状态更新覆盖。
    first.status.timestamp = '2026-01-01T00:00:00.000Z'
    second.status.timestamp = '2026-01-02T00:00:00.000Z'
    expect(store.list({ contextId: 'ctx-1' }).map(task => task.id)).toEqual([second.id, first.id])
    const done = store.list({ status: 'TASK_STATE_COMPLETED' })
    expect(done).toHaveLength(1)
    expect(done[0]?.id).toBe(first.id)
    expect('artifacts' in done[0]!).toBe(false)
    expect(store.list({ contextId: 'ctx-1' }, 1)).toHaveLength(1)
    expect(store.list({ contextId: 'ctx-1' }, 0)).toHaveLength(1)
    expect(store.list({ contextId: 'ctx-1' }, 5000)).toHaveLength(2)
    expect(store.count()).toBe(3)
  })

  it('游标读取后续页，游标行不在表里时返回空页', () => {
    const store = new TaskStore()
    const first = store.create('ctx-1')
    const second = store.create('ctx-1')
    const third = store.create('ctx-1')
    first.status.timestamp = '2026-01-01T00:00:00.000Z'
    second.status.timestamp = '2026-01-02T00:00:00.000Z'
    third.status.timestamp = '2026-01-03T00:00:00.000Z'
    const firstPage = store.list({ contextId: 'ctx-1' }, 2)
    expect(firstPage.map(task => task.id)).toEqual([third.id, second.id])
    const cursor = { timestamp: second.status.timestamp, id: second.id }
    expect(store.list({ contextId: 'ctx-1' }, 2, false, cursor).map(task => task.id)).toEqual([first.id])
    expect(store.list({ contextId: 'ctx-1' }, 2, false, { timestamp: cursor.timestamp, id: 'ghost' })).toEqual([])
  })

  it('保留工件内容由调用方决定', () => {
    const store = new TaskStore()
    const task = store.create()
    store.appendArtifact(task, 'reply', 'reply', 'hi')
    expect(store.list({}, 50, true)[0]?.artifacts).toHaveLength(1)
    expect('artifacts' in store.list({}, 50)[0]!).toBe(false)
  })

  it('历史超过上限时丢弃最旧的消息', () => {
    const store = new TaskStore({ maxHistory: 2 })
    const task = store.create()
    for (const text of ['一', '二', '三']) {
      store.pushHistory(task, { messageId: text, role: 'ROLE_USER', parts: [{ text }] })
    }
    expect(task.history.map(message => message.messageId)).toEqual(['二', '三'])
  })

  it('状态消息只在有文本时写入', () => {
    const store = new TaskStore()
    const task = store.create()
    store.setStatus(task, 'TASK_STATE_WORKING', '进行中')
    expect(task.status).toMatchObject({ state: 'TASK_STATE_WORKING', message: { parts: [{ text: '进行中' }] } })
    store.setStatus(task, 'TASK_STATE_COMPLETED', '')
    expect(task.status.message).toBeUndefined()
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('工件文本先追加到末段，再新建分段', () => {
    const store = new TaskStore()
    const task = store.create()
    store.appendArtifact(task, 'reply', 'reply', 'a')
    store.appendArtifact(task, 'reply', 'reply', 'b')
    expect(task.artifacts[0]?.parts).toEqual([{ text: 'ab' }])
    task.artifacts[0]?.parts.push({ url: 'x' })
    store.appendArtifact(task, 'reply', 'reply', 'c')
    expect(task.artifacts[0]?.parts).toEqual([{ text: 'ab' }, { url: 'x' }, { text: 'c' }])
  })

  it('超过上限时淘汰最旧的终态任务并清理会话索引', () => {
    const store = new TaskStore({ maxTasks: 2 })
    const done = store.create('ctx-1')
    store.setStatus(done, 'TASK_STATE_COMPLETED')
    const running = store.create('ctx-1')
    store.create('ctx-2')
    expect(store.get(done.id)).toBeUndefined()
    expect(store.get(running.id)).toBeDefined()
    expect(store.count()).toBe(2)
  })

  it('终态任务都在运行时不淘汰任何任务', () => {
    const store = new TaskStore({ maxTasks: 1 })
    store.create('ctx-1')
    store.create('ctx-2')
    expect(store.count()).toBe(2)
  })

  it('会话索引里没有该任务时淘汰仍然生效', () => {
    const store = new TaskStore({ maxTasks: 1 })
    const task = store.create('ctx-1')
    store.setStatus(task, 'TASK_STATE_COMPLETED')
    const orphan = store.create('ctx-2')
    store.setStatus(orphan, 'TASK_STATE_COMPLETED')
    expect(store.count()).toBe(1)
  })
})
