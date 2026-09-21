#!/usr/bin/env node
// 总线冒烟：建 topic、投递任务、消费、死信
import { createBus, loadConfig } from "@a2a-bridge/shared";
import process from "node:process";

const cfg = loadConfig();
const bus = createBus(cfg.bus);
console.log(`[smoke] 连接 ${cfg.bus.bootstrapServers.join(",")} ...`);
await bus.ensureTopics();
console.log("[smoke] topics 就绪");

let got = 0;
let dlqCheck = 0;
const runTaskId = crypto.randomUUID();
const runBadId = crypto.randomUUID();
const handle = await bus.consumeTasks("smoke", `smoke-${Date.now()}`, async (t) => {
  if (t.taskId !== runTaskId && t.taskId !== runBadId) return; // 只统计本轮，历史消息跳过
  got += 1;
  console.log(`[smoke] 收到任务 ${t.taskId.slice(0, 8)} skill=${t.skill} input=${t.input.text.slice(0, 40)} attempt=${t.attempt}`);
  if (t.input.text.includes("boom")) throw new Error("模拟执行失败");
});

await bus.produceTask({
  schema: "a2a.task/1", taskId: runTaskId, contextId: "smoke-ctx", from: "test", to: "smoke",
  skill: "test", input: { text: "hello bus" }, ts: Date.now(), attempt: 1,
});
await bus.produceTask({
  schema: "a2a.task/1", taskId: runBadId, contextId: "smoke-ctx", from: "test", to: "smoke",
  skill: "test", input: { text: "boom" }, ts: Date.now(), attempt: cfg.bus.maxAttempts, // 直接进 DLQ
});

const deadline = Date.now() + 30_000;
while (got < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));

// 读 DLQ 验证
const { Kafka, Partitioners } = await import("kafkajs");
const kafka = new Kafka({ clientId: "smoke", brokers: cfg.bus.bootstrapServers });
const admin = kafka.admin();
await admin.connect();
const consumer = kafka.consumer({ groupId: `dlq-read-${Date.now()}` });
await consumer.connect();
await consumer.subscribe({ topic: cfg.bus.dlqTopic, fromBeginning: true });
await consumer.run({
  eachMessage: async ({ message }) => {
    const v = JSON.parse(message.value?.toString() ?? "{}");
    if (v.task?.taskId !== runBadId) return; // 只统计本轮
    dlqCheck += 1;
    console.log(`[smoke] DLQ 收到: taskId=${String(v.task?.taskId).slice(0, 8)} error=${v.error ?? "?"}`);
  },
});
await new Promise((r) => setTimeout(r, 5000));
await consumer.stop();
await consumer.disconnect();
await admin.disconnect();
await handle.stop();
await bus.close();

const ok = got === 2 && dlqCheck === 1; // hello 成功 + boom 失败进 DLQ
console.log(ok ? "[smoke] PASS" : `[smoke] FAIL (got=${got}, dlq=${dlqCheck})`);
process.exit(ok ? 0 : 1);
