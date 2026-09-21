// Kafka API 总线（kafkajs）：任务投递 / 事件流 / 死信 / 幂等
import { Kafka, logLevel } from "kafkajs";
import type { Consumer } from "kafkajs";
import type { BusCfg } from "./config.js";
import type { BusEvent, BusTask } from "./schema.js";

export interface ConsumerHandle {
  stop(): Promise<void>;
}

export interface ConsumeTasksOptions {
  /** 每任务超时（ms）：超时按终态失败处理（onTimeout 收尾），直发 DLQ 并继续消费 */
  taskTimeoutMs?: number;
  /** 超时收尾钩子：调用方写任务表终态并发终态事件（任务已终态如取消时由调用方自行跳过） */
  onTimeout?: (t: BusTask) => void | Promise<void>;
}

export interface Bus {
  ensureTopics(): Promise<void>;
  produceTask(task: BusTask): Promise<void>;
  produceEvent(ev: BusEvent): Promise<void>;
  /** 订阅任务主题；只处理 to===self 的消息，其余跳过（位点照常提交） */
  consumeTasks(
    self: string,
    groupId: string,
    handler: (t: BusTask) => Promise<void>,
    opts?: ConsumeTasksOptions,
  ): Promise<ConsumerHandle>;
  /** 订阅事件主题（按 taskId 过滤由调用方做） */
  consumeEvents(groupId: string, handler: (e: BusEvent) => void): Promise<ConsumerHandle>;
  close(): Promise<void>;
}

const IDLE_TTL_MS = 10 * 60 * 1000;
/** 消费者崩溃重建的退避（CRASH/rejection 后 5s 起步，避免异常风暴） */
const RESTART_BACKOFF_MS = 5_000;

export function createBus(cfg: BusCfg): Bus {
  const kafka = new Kafka({
    clientId: "a2a-bridge",
    brokers: cfg.bootstrapServers,
    logLevel: logLevel.NOTHING,
  });
  const producer = kafka.producer();
  const consumers: Consumer[] = [];
  // 幂等：taskId → 完成时间（at-least-once 消费去重）
  const done = new Map<string, number>();
  function markDone(taskId: string): void {
    done.set(taskId, Date.now());
    if (done.size > 20000) {
      const cutoff = Date.now() - IDLE_TTL_MS;
      for (const [k, v] of done) if (v < cutoff) done.delete(k);
    }
  }

  function newConsumer(groupId: string): Consumer {
    // retry 策略可配置（kafkajs 默认 10 次 ~1min；crash→重建路径需要快时调小）
    const c = kafka.consumer({ groupId, allowAutoTopicCreation: true, ...(cfg.retry ? { retry: cfg.retry } : {}) });
    consumers.push(c);
    return c;
  }

  /** 停掉旧消费者实例（连接已断/已崩溃时忽略错误），并从 close 清理列表摘除 */
  async function disposeConsumer(c: Consumer): Promise<void> {
    const i = consumers.indexOf(c);
    if (i >= 0) consumers.splice(i, 1);
    try {
      await c.stop();
    } catch {
      /* 已停止 */
    }
    try {
      await c.disconnect();
    } catch {
      /* 已断开 */
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** 每任务超时错误：区分「处理器超时」（→DLQ 不重投）与「处理器错误」（→重投） */
  class TaskTimeoutError extends Error {}

  /** p 在 ms 内未 settle 则 reject TaskTimeoutError（p 本身不中断，继续在后台跑） */
  async function withTimeout(p: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const to = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new TaskTimeoutError(`任务执行超时 (${ms}ms)`)), ms);
    });
    try {
      await Promise.race([p, to]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 带自恢复的消费。kafkajs 2.2.4 语义（详见 docs/wiki/queries/kafkajs-run-crash-semantics.md）：
   * - run() 在 group join 完成时 resolve（不是消费者停止时），crash 不 reject；
   * - CRASH restart=true（retriable，如重试耗尽）：kafkajs 内部自重建，这里只记日志；
   * - CRASH restart=false（non-retriable，如 join 失败）：kafkajs 不自建 → 消费者静默死亡；
   * 因此：启动失败 / restart=false 崩溃时重建消费者（5s 防抖），restart=true 只记日志；stop 后不再重建。
   */
  async function runWithRecovery(
    groupId: string,
    topics: string[],
    start: (c: Consumer) => Promise<void>,
  ): Promise<ConsumerHandle> {
    let stopped = false;
    let c = newConsumer(groupId);
    const detail = (e: unknown): string => (e instanceof Error ? e.message : String(e));

    const boot = async (): Promise<void> => {
      try {
        await c.connect();
        for (const topic of topics) await c.subscribe({ topic, fromBeginning: true });
        await start(c); // group join 完成即 resolve；之后消费者在后台持续运行
      } catch (e) {
        if (stopped) return;
        console.error(`[bus] 消费者启动失败 groupId=${groupId}: ${detail(e)}（${RESTART_BACKOFF_MS / 1000}s 后重建）`);
        await rebuild();
      }
    };

    const onCrash = (ev: { payload?: { error?: unknown; restart?: boolean } }): void => {
      if (stopped) return;
      const p = ev.payload;
      if (p?.restart) {
        console.error(`[bus] 消费者崩溃，kafkajs 将自重建 groupId=${groupId}: ${detail(p.error)}`);
        return;
      }
      console.error(`[bus] 消费者崩溃（non-retriable，kafkajs 不自建）groupId=${groupId}: ${detail(p?.error)}（${RESTART_BACKOFF_MS / 1000}s 后重建）`);
      void rebuild();
    };

    const rebuild = async (): Promise<void> => {
      await disposeConsumer(c);
      await sleep(RESTART_BACKOFF_MS);
      if (stopped) return;
      c = newConsumer(groupId);
      c.on(c.events.CRASH, onCrash);
      void boot();
    };

    c.on(c.events.CRASH, onCrash);
    void boot();
    return {
      stop: async () => {
        stopped = true;
        await disposeConsumer(c);
      },
    };
  }

  async function connectAll(): Promise<void> {
    await producer.connect();
  }

  /** 等消费组真正加入 broker：fromBeginning=false 时组未分配位点，立即投递的事件会丢（新消费者从 LATEST 起读） */
  async function waitForGroup(groupId: string, timeoutMs = 15_000): Promise<void> {
    const admin = kafka.admin();
    await admin.connect();
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const r = await admin.describeGroups([groupId]);
        if ((r.groups ?? []).some((group) => group.groupId === groupId && group.state === "Stable" && group.members.length > 0)) return;
        if (Date.now() > deadline) return; // 超时继续（尽力而为，不阻塞启动）
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      await admin.disconnect();
    }
  }

  return {
    async ensureTopics() {
      await connectAll();
      const admin = kafka.admin();
      await admin.connect();
      await admin.createTopics({
        topics: [
          { topic: cfg.taskTopic, numPartitions: cfg.partitions },
          { topic: cfg.eventTopic, numPartitions: cfg.partitions },
          { topic: cfg.dlqTopic, numPartitions: 1 },
        ],
      });
      await admin.disconnect();
    },

    async produceTask(task) {
      await connectAll();
      await producer.send({
        topic: cfg.taskTopic,
        messages: [{ key: task.taskId, value: JSON.stringify(task) }],
      });
    },

    async produceEvent(ev) {
      await connectAll();
      await producer.send({
        topic: cfg.eventTopic,
        messages: [{ key: ev.contextId, value: JSON.stringify(ev) }],
      });
    },

    async consumeTasks(self, groupId, handler, opts) {
      const taskTimeoutMs = opts?.taskTimeoutMs;
      const handle = await runWithRecovery(groupId, [cfg.taskTopic], (c) =>
        c.run({
          eachMessage: async ({ message }) => {
            let task: BusTask;
            try {
              task = JSON.parse(message.value?.toString() ?? "") as BusTask;
            } catch {
              // 非法消息直接进 DLQ
              await producer.send({
                topic: cfg.dlqTopic,
                messages: [{ key: "malformed", value: JSON.stringify({ raw: message.value?.toString(), error: "invalid json", ts: Date.now() }) }],
              });
              return;
            }
            if (task.to !== self) return; // 不归我管，跳过
            if (done.has(task.taskId)) return; // 幂等去重
            try {
              // 每任务超时：卡死任务不得拖停该 agent 全部总线消费（超时后继续消费）
              if (taskTimeoutMs && taskTimeoutMs > 0) {
                await withTimeout(handler(task), taskTimeoutMs);
              } else {
                await handler(task);
              }
              markDone(task.taskId);
            } catch (e) {
              const detail = e instanceof Error ? e.message : String(e);
              if (e instanceof TaskTimeoutError) {
                console.error(`[bus] 任务执行超时 taskId=${task.taskId}（${taskTimeoutMs}ms），入 DLQ`);
                // 卡死不是瞬态失败：不重投（重投只会再卡满一次超时），直发 DLQ；
                // onTimeout 负责任务表终态 + 终态事件（调用方需跳过已终态任务，如已取消）
                try {
                  await opts?.onTimeout?.(task);
                } catch (te) {
                  console.error(`[bus] onTimeout 失败 taskId=${task.taskId}: ${te instanceof Error ? te.message : String(te)}`);
                }
                await producer.send({
                  topic: cfg.dlqTopic,
                  messages: [{ key: task.taskId, value: JSON.stringify({ task, error: `timeout after ${taskTimeoutMs}ms`, ts: Date.now() }) }],
                });
                markDone(task.taskId);
                return;
              }
              // 失败：重投（attempt+1）或 DLQ，然后正常提交原消息（重试是“新消息”，幂等去重防重复处理）
              const attempt = (task.attempt ?? 1) + 1;
              const toDlq = attempt > cfg.maxAttempts;
              console.error(`[bus] 任务处理失败 taskId=${task.taskId}（第 ${task.attempt ?? 1} 次）: ${detail}${toDlq ? "，已重投耗尽，入 DLQ" : "，重投"}`);
              if (toDlq) {
                await producer.send({
                  topic: cfg.dlqTopic,
                  messages: [{ key: task.taskId, value: JSON.stringify({ task, error: detail, ts: Date.now() }) }],
                });
              } else {
                await producer.send({
                  topic: cfg.taskTopic,
                  messages: [{ key: task.taskId, value: JSON.stringify({ ...task, attempt }) }],
                });
              }
            }
          },
        }),
      );
      // 等分区分配完成再返回：PreparingRebalance 窗口（约 20s）内任务不丢但不会消费，
      // 网关启动即就绪，新投递的任务数秒内被消费
      await waitForGroup(groupId);
      return handle;
    },

    async consumeEvents(groupId, handler) {
      const handle = await runWithRecovery(groupId, [cfg.eventTopic], (c) => {
        if (process.env.A2A_BUS_DEBUG) {
          for (const ev of [c.events.FETCH, c.events.GROUP_JOIN, c.events.CRASH, c.events.REBALANCING, c.events.STOP]) {
            c.on(ev, () => console.error(`[bus-debug] ${groupId} ${ev}`));
          }
        }
        // 事件流非关键路径：handler 内 catch 吞错，消费者本身不因事件处理失败而崩
        return c.run({
          eachMessage: async ({ message }) => {
            try {
              handler(JSON.parse(message.value?.toString() ?? "") as BusEvent);
            } catch {
              /* 事件丢失可容忍（非关键路径） */
            }
          },
        });
      });
      // 组未加入前投递会丢事件（“订阅后马上派活”场景），等分配完成再返回
      await waitForGroup(groupId);
      return handle;
    },

    async close() {
      for (const c of consumers) {
        try {
          await c.stop();
          await c.disconnect();
        } catch {
          /* 忽略关闭期错误 */
        }
      }
      try {
        await producer.disconnect();
      } catch {
        /* 忽略 */
      }
    },
  };
}
