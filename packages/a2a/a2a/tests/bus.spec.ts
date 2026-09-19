import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Kafka } from 'kafkajs'
import { createA2ABus } from '../src/bus.ts'
import type { A2ABusConfig } from '../src/bus.ts'
import type { BusEvent, BusTask } from '../src/schema.ts'

/** 一条已发送的消息，按 topic 与 key 记录。 */
interface SentMessage {
  topic: string
  key: string
  value: unknown
}

/** 消费端处理器收到的单条消息。 */
interface FakeMessage {
  key: Buffer | null
  value: Buffer | null
}

/**
 * Kafka 客户端替身：只实现总线用到的那几个方法。
 *
 * 总线自己的投递规则（幂等、重投、死信、超时、重建）都在真实实现里执行，
 * 替身负责把 broker 换成可编程的内存模型。
 */
class FakeKafka {
  readonly sent: SentMessage[] = []
  readonly createdTopics: string[][] = []
  readonly groupIds: string[] = []
  readonly consumerOptions: unknown[] = []
  /** 每次 eachMessage 调用的处理器，测试用 latest 驱动下一批消息。 */
  readonly handlers: ((args: { message: FakeMessage }) => Promise<void>)[] = []
  /** 每个消费者实例注册的 CRASH 处理器。 */
  crashHandlers: ((event: { payload?: { error?: unknown; restart?: boolean } }) => void)[] = []
  /** describeGroups 的返回值；默认已分配分区。 */
  groupState = 'Stable'
  groupMembers = 1
  /** 让 connect / run / subscribe 抛错，驱动重建路径。 */
  failConnect = false
  failRun = false
  consumerStops = 0
  producerConnects = 0
  producerDisconnects = 0

  readonly events = { CRASH: 'consumer.crash' }

  producer(): unknown {
    return {
      connect: async (): Promise<void> => {
        this.producerConnects += 1
      },
      send: async (args: { topic: string; messages: { key: string; value: string }[] }): Promise<void> => {
        for (const message of args.messages) {
          this.sent.push({ topic: args.topic, key: message.key, value: JSON.parse(message.value) })
        }
      },
      disconnect: async (): Promise<void> => {
        this.producerDisconnects += 1
      },
    }
  }

  admin(): unknown {
    return {
      connect: async (): Promise<void> => undefined,
      disconnect: async (): Promise<void> => undefined,
      createTopics: async (args: { topics: { topic: string }[] }): Promise<void> => {
        this.createdTopics.push(args.topics.map(topic => topic.topic))
      },
      describeGroups: async (ids: string[]): Promise<{ groups: { groupId: string; state: string; members: unknown[] }[] }> =>
        ({
          groups: ids.map(groupId => ({
            groupId,
            state: this.groupState,
            members: Array.from({ length: this.groupMembers }, () => ({})),
          })),
        }),
    }
  }

  consumer(options: { groupId: string }): unknown {
    this.consumerOptions.push(options)
    this.groupIds.push(options.groupId)
    const handlers = this.handlers
    const crashHandlers = this.crashHandlers
    return {
      events: this.events,
      connect: async (): Promise<void> => {
        if (this.failConnect) throw new Error('connect refused')
      },
      subscribe: async (): Promise<void> => undefined,
      run: async (args: { eachMessage: (input: { message: FakeMessage }) => Promise<void> }): Promise<void> => {
        if (this.failRun) throw new Error('run refused')
        handlers.push(args.eachMessage)
      },
      stop: async (): Promise<void> => {
        this.consumerStops += 1
      },
      disconnect: async (): Promise<void> => undefined,
      on: (event: string, handler: (input: { payload?: { error?: unknown; restart?: boolean } }) => void): void => {
        if (event === this.events.CRASH) crashHandlers.push(handler)
      },
    }
  }

  /** 驱动最近一个消费端处理器处理一条消息。 */
  async deliver(value: unknown, key = 'k'): Promise<void> {
    const handler = this.handlers.at(-1)
    if (handler === undefined) throw new Error('no consumer handler registered')
    await handler({
      message: {
        key: Buffer.from(key),
        value: typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value)),
      },
    })
  }

  /** 驱动最近一个 CRASH 处理器。 */
  crash(restart?: boolean): void {
    const handler = this.crashHandlers.at(-1)
    if (handler === undefined) throw new Error('no crash handler registered')
    handler({ payload: { error: new Error('boom'), ...restart === undefined ? {} : { restart } } })
  }

  /** 某个 topic 上已发送的消息。 */
  on(topic: string): SentMessage[] {
    return this.sent.filter(message => message.topic === topic)
  }
}

const CONFIG: A2ABusConfig = {
  bootstrapServers: ['127.0.0.1:9092'],
  taskTopic: 'a2a.task',
  eventTopic: 'a2a.event',
  dlqTopic: 'a2a.dlq',
  partitions: 6,
  maxAttempts: 3,
}

function busOf(kafka: FakeKafka, overrides: Partial<A2ABusConfig> = {}) {
  return createA2ABus({ ...CONFIG, ...overrides }, { client: kafka as unknown as Kafka })
}

function taskOf(overrides: Partial<BusTask> = {}): BusTask {
  return {
    schema: 'a2a.task/1',
    taskId: 't1',
    contextId: 'c1',
    from: 'dsh',
    to: 'claude-code',
    skill: 'code-review',
    input: { text: 'hello' },
    ts: 1,
    attempt: 1,
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('A2ABus 发布', () => {
  it('ensureTopics 建三个主题，生产者只连接一次', async () => {
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    await bus.ensureTopics()
    await bus.produceTask(taskOf())
    expect(kafka.createdTopics).toEqual([['a2a.task', 'a2a.event', 'a2a.dlq']])
    expect(kafka.producerConnects).toBe(1)
  })

  it('produceTask 按 taskId 作键，produceEvent 按 contextId 作键', async () => {
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    await bus.produceTask(taskOf())
    const event: BusEvent = {
      schema: 'a2a.event/1',
      taskId: 't1',
      contextId: 'c1',
      from: 'claude-code',
      type: 'terminal',
      state: 'TASK_STATE_COMPLETED',
      ts: 2,
    }
    await bus.produceEvent(event)
    expect(kafka.on('a2a.task')).toEqual([{ topic: 'a2a.task', key: 't1', value: taskOf() }])
    expect(kafka.on('a2a.event')).toEqual([{ topic: 'a2a.event', key: 'c1', value: event }])
  })

  it('关闭后再次关闭不再断开生产者', async () => {
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    await bus.produceTask(taskOf())
    await bus.close()
    await bus.close()
    expect(kafka.producerDisconnects).toBe(1)
  })
})

describe('A2ABus 任务消费', () => {
  it('只处理发给自己的任务，并按 taskId 去重', async () => {
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    const seen: string[] = []
    const handle = await bus.consumeTasks('claude-code', 'g1', async (task) => {
      seen.push(task.taskId)
    })
    await kafka.deliver(taskOf({ taskId: 'other', to: 'pi' }))
    await kafka.deliver(taskOf({ taskId: 'mine' }))
    await kafka.deliver(taskOf({ taskId: 'mine' }))
    expect(seen).toEqual(['mine'])
    await handle.stop()
    expect(kafka.consumerStops).toBe(1)
  })

  it('非法 JSON 直接进死信，不打断消费', async () => {
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    await bus.consumeTasks('claude-code', 'g1', async () => undefined)
    await kafka.deliver('{ not json')
    const dlq = kafka.on('a2a.dlq')
    expect(dlq).toHaveLength(1)
    expect(dlq[0]?.key).toBe('malformed')
  })

  it('处理失败按 attempt 重投，超过上限进死信', async () => {
    const kafka = new FakeKafka()
    const bus = busOf(kafka, { maxAttempts: 2 })
    await bus.consumeTasks('claude-code', 'g1', async () => {
      throw new Error('handler exploded')
    })
    await kafka.deliver(taskOf({ attempt: 1 }))
    expect(kafka.on('a2a.task').at(-1)?.value).toMatchObject({ attempt: 2 })
    await kafka.deliver(taskOf({ attempt: 2 }))
    const dlq = kafka.on('a2a.dlq')
    expect(dlq).toHaveLength(1)
    expect((dlq[0]?.value as { error: string }).error).toBe('handler exploded')
  })

  it('任务超时落死信并调用 onTimeout，不重投', async () => {
    vi.useFakeTimers()
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    const timedOut: string[] = []
    await bus.consumeTasks('claude-code', 'g1', async () => await new Promise(() => undefined), {
      taskTimeoutMs: 50,
      onTimeout: (task) => {
        timedOut.push(task.taskId)
      },
    })
    const delivered = kafka.deliver(taskOf())
    await vi.advanceTimersByTimeAsync(60)
    await delivered
    expect(timedOut).toEqual(['t1'])
    expect(kafka.on('a2a.task')).toHaveLength(0)
    expect((kafka.on('a2a.dlq')[0]?.value as { error: string }).error).toBe('timeout after 50ms')
  })

  it('onTimeout 抛错时把钩子错误一并写入死信', async () => {
    vi.useFakeTimers()
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    await bus.consumeTasks('claude-code', 'g1', async () => await new Promise(() => undefined), {
      taskTimeoutMs: 50,
      onTimeout: () => {
        throw new Error('hook failed')
      },
    })
    const delivered = kafka.deliver(taskOf())
    await vi.advanceTimersByTimeAsync(60)
    await delivered
    const errors = kafka.on('a2a.dlq').map(message => (message.value as { error: string }).error)
    expect(errors).toEqual(['onTimeout failed: hook failed', 'timeout after 50ms'])
  })

  it('未配置超时时不设期限', async () => {
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    let ran = false
    await bus.consumeTasks('claude-code', 'g1', async () => {
      ran = true
    }, {})
    await kafka.deliver(taskOf())
    expect(ran).toBe(true)
  })
})

describe('A2ABus 事件消费', () => {
  it('读出事件，处理器抛错不打断消费', async () => {
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    const seen: string[] = []
    const handle = await bus.consumeEvents('g2', (event) => {
      if (event.taskId === 'bad') throw new Error('reader exploded')
      seen.push(event.taskId)
    })
    await kafka.deliver({ schema: 'a2a.event/1', taskId: 'good', contextId: 'c', from: 'x', type: 'terminal', ts: 1 })
    await kafka.deliver({ schema: 'a2a.event/1', taskId: 'bad', contextId: 'c', from: 'x', type: 'terminal', ts: 1 })
    expect(seen).toEqual(['good'])
    await handle.stop()
  })

  it('非法事件体被忽略', async () => {
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    await bus.consumeEvents('g2', () => {
      throw new Error('must not be called')
    })
    await kafka.deliver('{ not json')
  })
})

describe('A2ABus 消费者自恢复', () => {
  it('启动失败后按退避重建消费者', async () => {
    vi.useFakeTimers()
    const kafka = new FakeKafka()
    kafka.failConnect = true
    const bus = busOf(kafka)
    const pending = bus.consumeEvents('g3', () => undefined)
    await vi.advanceTimersByTimeAsync(1)
    expect(kafka.groupIds).toEqual(['g3'])
    await vi.advanceTimersByTimeAsync(5_000)
    // 重建后连接成功，新的消费者注册完成
    kafka.failConnect = false
    await vi.advanceTimersByTimeAsync(1)
    const handle = await pending
    expect(kafka.groupIds.length).toBeGreaterThan(1)
    await handle.stop()
  })

  it('不可重试的崩溃触发重建，可重试的崩溃交给 kafkajs', async () => {
    vi.useFakeTimers()
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    const pending = bus.consumeEvents('g4', () => undefined)
    await vi.advanceTimersByTimeAsync(1)
    const before = kafka.groupIds.length
    kafka.crash(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(kafka.groupIds.length).toBe(before)
    kafka.crash(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(kafka.groupIds.length).toBeGreaterThan(before)
    const handle = await pending
    await handle.stop()
  })

  it('停止后不再重建', async () => {
    vi.useFakeTimers()
    const kafka = new FakeKafka()
    const bus = busOf(kafka)
    const pending = bus.consumeEvents('g5', () => undefined)
    await vi.advanceTimersByTimeAsync(1)
    const handle = await pending
    await handle.stop()
    const before = kafka.groupIds.length
    kafka.crash(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(kafka.groupIds.length).toBe(before)
  })

  it('消费组迟迟未分配时按超时兜底返回', async () => {
    vi.useFakeTimers()
    const kafka = new FakeKafka()
    kafka.groupMembers = 0
    const bus = busOf(kafka)
    const pending = bus.consumeEvents('g6', () => undefined)
    let settled = false
    void pending.then(() => { settled = true })
    // 每 200ms 查询一次组状态，直到 15s 兜底
    for (let i = 0; i < 100 && !settled; i++) await vi.advanceTimersByTimeAsync(200)
    const handle = await pending
    expect(kafka.groupIds).toEqual(['g6'])
    await handle.stop()
  })
})
