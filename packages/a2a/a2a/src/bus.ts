import { Kafka, logLevel } from 'kafkajs'
import type { Consumer, Producer } from 'kafkajs'
import type { BusEvent, BusTask } from './schema.ts'

/**
 * Bus deployment settings, mirroring the bridge's `bus` section so both sides
 * of one deployment read the same file.
 */
export interface A2ABusConfig {
  /** Broker addresses the client bootstraps from, such as `127.0.0.1:9092`. */
  bootstrapServers: string[]
  /** Topic carrying tasks, keyed by task id. */
  taskTopic: string
  /** Topic carrying progress events, keyed by conversation id. */
  eventTopic: string
  /** Topic receiving tasks that exhausted their attempts. */
  dlqTopic: string
  /** Partitions created for the task and event topics. */
  partitions: number
  /** Delivery attempts a task gets before it moves to the dead-letter topic. */
  maxAttempts: number
  /** Consumer retry timing, when a deployment needs faster crash recovery. */
  retry?: {
    /** Total time, in milliseconds, retries may span. */
    maxRetryTime?: number
    /** Delay before the first retry, in milliseconds. */
    initialRetryTime?: number
    /** Multiplier applied to each successive retry delay. */
    factor?: number
    /** Randomization applied to retry delays, between 0 and 1. */
    multiplier?: number
    /** Number of retries before the failure surfaces. */
    retries?: number
  }
}

/** One running consumer, stopped when its owner shuts down. */
export interface A2ABusHandle {
  /** Stop consuming and release the consumer's broker connections. */
  stop(): Promise<void>
}

/** How a task consumer handles a task that never finishes. */
export interface A2AConsumeOptions {
  /** Per-task deadline in milliseconds; a task past it fails and moves to the dead-letter topic. */
  taskTimeoutMs?: number
  /**
   * Called when a task hits {@link A2AConsumeOptions.taskTimeoutMs}, so the
   * owner can record the failure and publish a terminal event. The task has
   * already left the consumer's hands, so this hook cannot requeue it.
   */
  onTimeout?: (task: BusTask) => void | Promise<void>
}

/**
 * The task and event channels over Kafka.
 *
 * Delivery is at least once: a task is executed to completion before its offset
 * is committed, and task ids are remembered so a redelivery is skipped rather
 * than executed twice.
 */
export interface A2ABus {
  /** Create the task, event, and dead-letter topics if they are missing. */
  ensureTopics(): Promise<void>
  /** Publish one task. */
  produceTask(task: BusTask): Promise<void>
  /** Publish one progress event. */
  produceEvent(event: BusEvent): Promise<void>
  /**
   * Claim tasks addressed to `self`, skipping every other addressee.
   * @param self - agent name this consumer answers for.
   * @param groupId - consumer group the caller owns; one per agent or per reader.
   * @param handler - runs one task to completion; a throw requeues it.
   * @param options - deadline and timeout reporting for a task that hangs.
   * @returns the running consumer.
   */
  consumeTasks(
    self: string,
    groupId: string,
    handler: (task: BusTask) => Promise<void>,
    options?: A2AConsumeOptions,
  ): Promise<A2ABusHandle>
  /**
   * Read every progress event from the topics this consumer group reads.
   * @param groupId - consumer group the caller owns.
   * @param handler - receives each event; filtering by task is the caller's job.
   * @returns the running consumer.
   */
  consumeEvents(groupId: string, handler: (event: BusEvent) => void): Promise<A2ABusHandle>
  /** Stop every consumer and disconnect the producer. */
  close(): Promise<void>
}

/** How long a finished task id is remembered for redelivery suppression. */
const DONE_TTL_MS = 10 * 60 * 1000

/** How many finished task ids are remembered before the oldest are dropped. */
const DONE_CAPACITY = 20_000

/** Delay before rebuilding a consumer whose connection died for good. */
const RESTART_BACKOFF_MS = 5_000

/** How long startup waits for the consumer group to own its partitions. */
const GROUP_READY_TIMEOUT_MS = 15_000

/** Raised when a task outruns its deadline, which is terminal rather than retryable. */
class TaskTimeoutError extends Error {}

/** Read a thrown value's message without assuming it is an `Error`. */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Where a bus gets its Kafka client. */
export interface A2ABusOptions {
  /**
   * Kafka client to talk through, when the caller supplies its own. Tests use
   * this to drive the bus's delivery rules without a broker; deployments leave
   * it unset and the bus builds a client over `bootstrapServers`.
   */
  client?: Kafka
}

/**
 * Create the bus over a Kafka cluster.
 *
 * Consumers rejoin their group the moment the broker accepts them, and the
 * returned handles stay live until {@link A2ABus.close}. A consumer whose
 * connection fails in a way kafkajs will not rebuild is rebuilt here, because a
 * silently dead consumer stops an agent from receiving work at all.
 * @param config - broker addresses, topics, and delivery limits.
 * @param options - client override, for a caller that owns the connection.
 * @returns the bus this deployment publishes and consumes through.
 */
export function createA2ABus(config: A2ABusConfig, options: A2ABusOptions = {}): A2ABus {
  const kafka = options.client ?? new Kafka({
    clientId: 'dsh-a2a',
    brokers: config.bootstrapServers,
    logLevel: logLevel.NOTHING,
  })
  const producer: Producer = kafka.producer()
  const consumers: Consumer[] = []
  const done = new Map<string, number>()
  let producerConnected = false

  /** Remember a finished task so its redelivery is skipped. */
  function markDone(taskId: string): void {
    done.set(taskId, Date.now())
    if (done.size <= DONE_CAPACITY) return
    const cutoff = Date.now() - DONE_TTL_MS
    for (const [id, at] of done) if (at < cutoff) done.delete(id)
  }

  /** Connect the producer once; later publishes reuse the connection. */
  async function connectProducer(): Promise<void> {
    if (producerConnected) return
    await producer.connect()
    producerConnected = true
  }

  /** Send one message, connecting first when this is the first publish. */
  async function publish(topic: string, key: string, value: unknown): Promise<void> {
    await connectProducer()
    await producer.send({ topic, messages: [{ key, value: JSON.stringify(value) }] })
  }

  /** Detach a consumer that is being replaced or shut down. */
  async function disposeConsumer(consumer: Consumer): Promise<void> {
    const index = consumers.indexOf(consumer)
    if (index >= 0) consumers.splice(index, 1)
    try {
      await consumer.stop()
    } catch {
      // The consumer is already stopped; nothing is left to release.
    }
    try {
      await consumer.disconnect()
    } catch {
      // The connection is already gone; nothing is left to release.
    }
  }

  /** Wait until the group owns partitions, so nothing published now is missed. */
  async function waitForGroup(groupId: string): Promise<void> {
    const admin = kafka.admin()
    await admin.connect()
    try {
      const deadline = Date.now() + GROUP_READY_TIMEOUT_MS
      for (;;) {
        const described = await admin.describeGroups([groupId])
        const owned = (described.groups ?? []).some(group =>
          group.groupId === groupId && group.state === 'Stable' && group.members.length > 0)
        // A group that never reaches Stable is a slow broker, not a failed
        // start: the consumer keeps joining in the background.
        if (owned || Date.now() > deadline) return
        await delay(200)
      }
    } finally {
      await admin.disconnect()
    }
  }

  /**
   * Run a consumer, rebuilding it when kafkajs gives up on the connection.
   *
   * `run` resolves once the group has joined, so a later crash does not reject
   * it: a crash with `restart` set is rebuilt by kafkajs itself, and one
   * without it leaves the consumer dead, which is what this rebuilds.
   */
  async function runWithRecovery(
    groupId: string,
    topic: string,
    start: (consumer: Consumer) => Promise<void>,
  ): Promise<A2ABusHandle> {
    let stopped = false
    let consumer = newConsumer(groupId)

    const rebuild = async (): Promise<void> => {
      await disposeConsumer(consumer)
      await delay(RESTART_BACKOFF_MS)
      if (stopped) return
      consumer = newConsumer(groupId)
      consumer.on(consumer.events.CRASH, onCrash)
      void boot()
    }

    const onCrash = (event: { payload?: { error?: unknown; restart?: boolean } }): void => {
      if (stopped) return
      const payload = event.payload
      if (payload?.restart === true) return
      void rebuild()
    }

    const boot = async (): Promise<void> => {
      try {
        await consumer.connect()
        await consumer.subscribe({ topic, fromBeginning: true })
        await start(consumer)
      } catch (error) {
        if (stopped) return
        // Group join and connection failures are retried in full: the agent
        // stops receiving tasks otherwise, and silence here hides that.
        await rebuild()
        void error
      }
    }

    consumer.on(consumer.events.CRASH, onCrash)
    void boot()
    return {
      stop: async (): Promise<void> => {
        stopped = true
        await disposeConsumer(consumer)
      },
    }
  }

  /** A consumer for one group, tracked so {@link A2ABus.close} can stop it. */
  function newConsumer(groupId: string): Consumer {
    const consumer = kafka.consumer({
      groupId,
      allowAutoTopicCreation: true,
      ...config.retry === undefined ? {} : { retry: config.retry },
    })
    consumers.push(consumer)
    return consumer
  }

  /** Reject `work` once `ms` elapse, leaving it running in the background. */
  async function withDeadline(work: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TaskTimeoutError(`task exceeded ${ms}ms`)), ms)
    })
    try {
      await Promise.race([work, expired])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  return {
    async ensureTopics(): Promise<void> {
      await connectProducer()
      const admin = kafka.admin()
      await admin.connect()
      try {
        await admin.createTopics({
          topics: [
            { topic: config.taskTopic, numPartitions: config.partitions },
            { topic: config.eventTopic, numPartitions: config.partitions },
            { topic: config.dlqTopic, numPartitions: 1 },
          ],
        })
      } finally {
        await admin.disconnect()
      }
    },

    async produceTask(task: BusTask): Promise<void> {
      await publish(config.taskTopic, task.taskId, task)
    },

    async produceEvent(event: BusEvent): Promise<void> {
      await publish(config.eventTopic, event.contextId, event)
    },

    async consumeTasks(
      self: string,
      groupId: string,
      handler: (task: BusTask) => Promise<void>,
      options: A2AConsumeOptions = {},
    ): Promise<A2ABusHandle> {
      const deadline = options.taskTimeoutMs
      const handle = await runWithRecovery(groupId, config.taskTopic, consumer =>
        consumer.run({
          eachMessage: async ({ message }): Promise<void> => {
            const raw = message.value?.toString() ?? ''
            let task: BusTask
            try {
              task = JSON.parse(raw) as BusTask
            } catch (error) {
              // An unreadable message cannot be executed or retried, so it
              // moves aside instead of blocking the partition.
              await publish(config.dlqTopic, 'malformed', { raw, error: detailOf(error), ts: Date.now() })
              return
            }
            if (task.to !== self) return
            if (done.has(task.taskId)) return
            try {
              if (deadline !== undefined && deadline > 0) await withDeadline(handler(task), deadline)
              else await handler(task)
              markDone(task.taskId)
            } catch (error) {
              if (error instanceof TaskTimeoutError) {
                // A hung task is not a transient failure: retrying it would
                // occupy the consumer for another full deadline, so it goes
                // straight to the dead-letter topic.
                try {
                  await options.onTimeout?.(task)
                } catch (hookError) {
                  await publish(config.dlqTopic, task.taskId, {
                    task,
                    error: `onTimeout failed: ${detailOf(hookError)}`,
                    ts: Date.now(),
                  })
                }
                await publish(config.dlqTopic, task.taskId, {
                  task,
                  error: `timeout after ${deadline}ms`,
                  ts: Date.now(),
                })
                markDone(task.taskId)
                return
              }
              const attempt = (task.attempt ?? 1) + 1
              if (attempt > config.maxAttempts) {
                await publish(config.dlqTopic, task.taskId, { task, error: detailOf(error), ts: Date.now() })
              } else {
                await publish(config.taskTopic, task.taskId, { ...task, attempt })
              }
            }
          },
        }),
      )
      // Readiness is part of the returned handle: a group that has not been
      // assigned yet would let a task published right now wait out a rebalance.
      await waitForGroup(groupId)
      return handle
    },

    async consumeEvents(groupId: string, handler: (event: BusEvent) => void): Promise<A2ABusHandle> {
      const handle = await runWithRecovery(groupId, config.eventTopic, consumer =>
        consumer.run({
          eachMessage: async ({ message }): Promise<void> => {
            try {
              handler(JSON.parse(message.value?.toString() ?? '') as BusEvent)
            } catch {
              // Events are a progress channel, not the task record: a reader
              // that fails on one event must not stop reading the rest.
            }
          },
        }),
      )
      await waitForGroup(groupId)
      return handle
    },

    async close(): Promise<void> {
      for (const consumer of [...consumers]) {
        try {
          await consumer.stop()
          await consumer.disconnect()
        } catch {
          // Shutting down ignores connections that already failed.
        }
      }
      consumers.length = 0
      if (!producerConnected) return
      try {
        await producer.disconnect()
      } catch {
        // Shutting down ignores a connection that already failed.
      }
      producerConnected = false
    },
  }
}

/** Resolve after a delay. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
