#!/usr/bin/env node
// a2a 派发：pi 编排入口。
// 用法:
//   node cli/dispatch.mjs --to claude-code --skill code-review --input "审查当前 diff" [--workspace D:/file/x] [--context <id>] [--mode direct|bus] [--timeout 600000]
//     [--push <webhook>] [--push-token <t>] [--push-auth "Bearer <credentials>"]
// direct = A2A 直连（流式回显）；bus = 走 Kafka 总线（异步，发完即返回 taskId，--wait 可等终态）
// --push = 注册 webhook 接收任务事件（direct 走内联配置；bus 任务落库后按 taskId 注册，有界重试）
import { A2AClient, createBus, loadConfig, isTerminal } from "@a2a-bridge/shared";
import process from "node:process";

const args = process.argv.slice(2);
function get(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`缺少参数值: --${name}`);
  return v;
}
function has(name) {
  return args.includes(`--${name}`);
}

const to = get("to", "");
const skill = get("skill", "default");
const input = get("input", "");
if (!to || !input) {
  console.error("用法: dispatch.mjs --to <pi|claude-code|opencode> --skill <id> --input <text> [--workspace <dir>] [--context <id>] [--mode direct|bus] [--wait] [--push <webhook>]");
  process.exit(2);
}
const workspace = get("workspace");
const contextId = get("context");
const mode = get("mode", "direct");
const wait = has("wait");
const timeoutMs = Number(get("timeout", 10 * 60 * 1000));
// --push：webhook 配置（token 兼容旧版惯例头；auth 为 "<scheme> <credentials>"）
const pushUrl = get("push");
const pushAuth = (() => {
  const spec = get("push-auth");
  if (!spec) return undefined;
  const [scheme, ...rest] = spec.trim().split(/\s+/);
  return { scheme, ...(rest.length ? { credentials: rest.join(" ") } : {}) };
})();
const pushCfg = pushUrl
  ? { url: pushUrl, ...(get("push-token") ? { token: get("push-token") } : {}), ...(pushAuth ? { authentication: pushAuth } : {}) }
  : undefined;

/** bus 模式：任务由网关消费时才落库，注册 push 配置需有界重试等待任务创建。
 *  窗口给到 30s：强杀过的网关会留下消费者组残留成员，新实例接手分区需等 sessionTimeout */
async function registerPush(client, taskId, cfgPush) {
  for (let i = 0; i < 120; i++) {
    try {
      return await client.createTaskPushNotificationConfig({ ...cfgPush, taskId });
    } catch (e) {
      if (i === 119) throw new Error(`push 配置注册失败（任务未创建？）: ${e.message}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

const cfg = loadConfig();
const port = cfg.agents[to]?.port;
if (!port) throw new Error(`未知 agent: ${to}（可用: ${Object.keys(cfg.agents).join(", ")}）`);

if (mode === "bus") {
  const bus = createBus(cfg.bus);
  await bus.ensureTopics();
  const taskId = crypto.randomUUID();
  const ctx = contextId ?? crypto.randomUUID();
  const produce = () =>
    bus.produceTask({
      schema: "a2a.task/1",
      taskId,
      contextId: ctx,
      from: "pi",
      to,
      skill,
      input: { text: input, ...(workspace ? { workspace } : {}) },
      ts: Date.now(),
      attempt: 1,
    });
  if (!wait) {
    await produce();
    if (pushCfg) {
      const client = new A2AClient(`http://127.0.0.1:${port}/`, cfg.apiKey || undefined);
      const out = await registerPush(client, taskId, pushCfg);
      console.error(`[bus] push 配置已注册 id=${out.id} → ${pushCfg.url}`);
    }
    console.error(`[bus] 任务已投递 taskId=${taskId} contextId=${ctx} → ${to}/${skill}`);
    await bus.close();
    console.log(JSON.stringify({ taskId, contextId: ctx, mode: "bus", status: "dispatched" }));
    process.exit(0);
  }
  // --wait：先订阅事件再投递。新消费组从加入时的最新位点起读（fromBeginning=false），
  // 若先投递，网关抢跑发出的事件（working/早期 artifact）会丢
  const events = [];
  const handle = await bus.consumeEvents(`cli-${taskId}`, (e) => {
    if (e.taskId === taskId) {
      if (e.type === "artifact-update" && e.text) process.stdout.write(e.text);
      events.push(e);
    }
  });
  await produce();
  if (pushCfg) {
    const client = new A2AClient(`http://127.0.0.1:${port}/`, cfg.apiKey || undefined);
    const out = await registerPush(client, taskId, pushCfg);
    console.error(`[bus] push 配置已注册 id=${out.id} → ${pushCfg.url}`);
  }
  console.error(`[bus] 任务已投递 taskId=${taskId} contextId=${ctx} → ${to}/${skill}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      console.error("\n[bus] 等待超时");
      process.exit(3);
    }
    const term = events.find((e) => e.type === "terminal");
    if (term) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await handle.stop();
  await bus.close();
  const term = events.find((e) => e.type === "terminal");
  console.log(JSON.stringify({ taskId, contextId: ctx, mode: "bus", status: term.state, error: term.error }));
  process.exit(term.state === "TASK_STATE_COMPLETED" ? 0 : 1);
}

// direct：A2A v1.0 流式（StreamResponse oneof：task/statusUpdate/artifactUpdate）
const client = new A2AClient(`http://127.0.0.1:${port}/`, cfg.apiKey || undefined);
let finalTask;
for await (const ev of client.sendMessageStream(
  {
    contextId,
    text: input,
    metadata: { skill, ...(workspace ? { workspace } : {}) },
  },
  pushCfg ? { taskPushNotificationConfig: pushCfg } : undefined,
)) {
  if (ev.task) {
    finalTask = ev.task;
  } else if (ev.statusUpdate) {
    const st = ev.statusUpdate.status.state;
    if (st === "TASK_STATE_WORKING") process.stderr.write(`[a2a] working (task ${ev.statusUpdate.taskId})\n`);
    if (isTerminal(st)) process.stderr.write(`[a2a] ${st}\n`);
  } else if (ev.artifactUpdate) {
    const p = ev.artifactUpdate.artifact?.parts?.[0];
    if (p?.text) process.stdout.write(p.text);
  }
}
process.stdout.write("\n");
const task = finalTask ? await client.getTask(finalTask.id).catch(() => finalTask) : undefined;
const resultText = task?.artifacts?.find((a) => a.artifactId === "reply")
  ?.parts.map((p) => p.text ?? "").join("") ?? "";
console.log(JSON.stringify({ taskId: task?.id, contextId: task?.contextId, status: task?.status.state, result: resultText.slice(0, 4000), mode: "direct" }));
process.exit(task?.status.state === "TASK_STATE_COMPLETED" ? 0 : 1);
