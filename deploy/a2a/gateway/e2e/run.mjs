// E2E：单进程内启动三网关，跑全部场景（批量验证用）
import { A2AClient, loadConfig, createBus, isTerminal, createA2AServer, resolveCliBin } from "@a2a-bridge/shared";
import { startPiGateway } from "../packages/pi-gateway/dist/index.js";
import { startCcGateway } from "../packages/cc-gateway/dist/index.js";
import { startOcGateway } from "../packages/oc-gateway/dist/index.js";
import { startOcServer } from "../packages/oc-gateway/dist/opencode.js";
import http from "node:http";
import net from "node:net";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const cfg = loadConfig();
// e2e 专用：加快 kafkajs 处理器异常后的重试→crash→重建路径（默认 10 次要 ~1min）
cfg.bus.retry = { initialRetryTime: 200, retries: 3 };
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 端口是否仍有进程监听（探活一次即断开） */
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

const bus = createBus(cfg.bus);
try {
  await bus.ensureTopics();
  check("bus: ensureTopics", true, cfg.bus.bootstrapServers.join(","));
} catch (e) {
  check("bus: ensureTopics", false, e.message);
  console.log("\n总线不可用，后续总线场景跳过。");
}

const piGw = await startPiGateway(cfg, bus);
const ccGw = await startCcGateway(cfg, bus);
const ocGw = await startOcGateway(cfg, bus);
await piGw.server.ready;
await ccGw.server.ready; // 确保端口真正 bind 后再开测，避免 ECONNREFUSED 竞态
await ocGw.server.ready;
const pi = new A2AClient(`http://127.0.0.1:${cfg.agents.pi.port}/`, cfg.apiKey || undefined);
const cc = new A2AClient(`http://127.0.0.1:${cfg.agents["claude-code"].port}/`, cfg.apiKey || undefined);
const oc = new A2AClient(`http://127.0.0.1:${cfg.agents.opencode.port}/`, cfg.apiKey || undefined);

// S1 发现
try {
  const c1 = await pi.getCard();
  const c2 = await cc.getCard();
  const c3 = await oc.getCard();
  check("S1 发现", c1.skills.length >= 3 && c2.skills.length >= 2 && c3.skills.length >= 3, `${c1.name}/${c2.name}/${c3.name}`);
} catch (e) {
  check("S1 发现", false, e.message);
}

// S2 pi → CC 同步审查（真实小任务：skill-market 最近提交的 diff 审查）
try {
  let gotDelta = false;
  let finalState;
  let taskId;
  for await (const ev of cc.sendMessageStream({
    text: "审查 D:/file/skill-market 仓库最近一次提交的 git diff（git show HEAD），只列出发现的问题清单；若无问题回答 PASS。限 3 次工具调用内完成。",
    metadata: { skill: "code-review", workspace: "D:/file/skill-market" },
  })) {
    if (ev.task) taskId = ev.task.id;
    if (ev.artifactUpdate) gotDelta = true;
    if (ev.statusUpdate && isTerminal(ev.statusUpdate.status.state)) finalState = ev.statusUpdate.status.state;
  }
  const task = await cc.getTask(taskId);
  const hasText = task.artifacts.some((a) => a.parts.some((p) => p.text?.length > 0));
  check("S2 pi→CC 同步审查", finalState === "TASK_STATE_COMPLETED" && gotDelta && hasText, `state=${finalState}`);
} catch (e) {
  check("S2 pi→CC 同步审查", false, e.message);
}

// S3 多轮：同 context 第二问（验证 stream-json 长活会话）
try {
  const ctx = crypto.randomUUID();
  let t1;
  for await (const ev of cc.sendMessageStream({ contextId: ctx, text: "记住这个数字：42。只需回答'已记住'。", metadata: { skill: "code-review" } })) {
    if (ev.task) t1 = ev.task;
  }
  let t2final;
  let t2text = "";
  for await (const ev of cc.sendMessageStream({ contextId: ctx, text: "刚才我让你记住的数字是多少？只回答数字。", metadata: { skill: "code-review" } })) {
    if (ev.artifactUpdate) t2text += ev.artifactUpdate.artifact.parts[0]?.text ?? "";
    if (ev.statusUpdate && isTerminal(ev.statusUpdate.status.state)) t2final = ev.statusUpdate.status.state;
  }
  check("S3 CC 多轮会话", t2final === "TASK_STATE_COMPLETED" && t2text.includes("42"), `state=${t2final} 回答: ${t2text.trim().slice(0, 40)}`);
} catch (e) {
  check("S3 CC 多轮会话", false, e.message);
}

// S4 CC → pi 同步（pi 做只读分析）
try {
  let finalState;
  let text = "";
  for await (const ev of pi.sendMessageStream({
    text: "只读任务：列出 D:/file/a2a-bridge/cli 目录下的文件名，用逗号分隔回答。不要修改任何文件。",
    metadata: { skill: "analysis", workspace: "D:/file/a2a-bridge" },
  })) {
    if (ev.artifactUpdate) text += ev.artifactUpdate.artifact.parts[0]?.text ?? "";
    if (ev.statusUpdate && isTerminal(ev.statusUpdate.status.state)) finalState = ev.statusUpdate.status.state;
  }
  check("S4 CC→pi 分析", finalState === "TASK_STATE_COMPLETED" && text.length > 0, text.trim().slice(0, 80));
} catch (e) {
  check("S4 CC→pi 分析", false, e.message);
}

// S5 总线异步任务：pi 派活给 CC（--wait 语义在网关内验证：发任务→等终态事件）
try {
  const taskId = crypto.randomUUID();
  const ctx = crypto.randomUUID();
  const events = [];
  // 先订阅再投递，避免消费组未加入时丢早期事件（与 cli/dispatch.mjs 同因）
  const handle = await bus.consumeEvents(`e2e-${taskId}`, (e) => {
    if (e.taskId === taskId) events.push(e);
  });
  await bus.produceTask({
    schema: "a2a.task/1", taskId, contextId: ctx, from: "pi", to: "claude-code",
    skill: "code-review", input: { text: "回答：1+1=? 只回答数字，不调用任何工具。", workspace: "D:/file/a2a-bridge" },
    ts: Date.now(), attempt: 1,
  });
  const deadline = Date.now() + 300_000;
  let term;
  while (Date.now() < deadline) {
    term = events.find((e) => e.type === "terminal");
    if (term) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await handle.stop();
  const arts = events.filter((e) => e.type === "artifact-update").map((e) => e.text ?? "").join("");
  check("S5 总线异步任务", term?.state === "TASK_STATE_COMPLETED" && arts.includes("2"), `state=${term?.state} artifact=${arts.trim().slice(0, 40)}`);
} catch (e) {
  check("S5 总线异步任务", false, e.message);
}

// S6 取消：tasks/cancel 接口可用
try {
  const ctx = crypto.randomUUID();
  let taskId;
  const iter = cc.sendMessageStream({
    text: "写一段 500 字的诗歌。",
    metadata: { skill: "code-review" },
    contextId: ctx,
  });
  for await (const ev of iter) {
    if (ev.task) {
      taskId = ev.task.id;
      break; // 任务开始流式输出后即取消
    }
  }
  if (taskId) {
    await iter.return(); // 关闭 SSE，避免悬挂
    const cancelled = await cc.cancelTask(taskId);
    check("S6 tasks/cancel", cancelled.status.state === "TASK_STATE_CANCELED", cancelled.status.state);
  } else {
    check("S6 tasks/cancel", false, "未拿到 taskId");
  }
} catch (e) {
  check("S6 tasks/cancel", false, e.message);
}

// S7 pi → OC 只读分析（bridge-review agent：无 bash/edit 工具）
try {
  let finalState;
  let text = "";
  let gotDelta = false;
  for await (const ev of oc.sendMessageStream({
    text: "只读任务：列出 D:/file/a2a-bridge/cli 目录下的文件名，用逗号分隔回答。不要修改任何文件。",
    metadata: { skill: "analysis", workspace: "D:/file/a2a-bridge" },
  })) {
    if (ev.artifactUpdate) {
      gotDelta = true;
      text += ev.artifactUpdate.artifact.parts[0]?.text ?? "";
    }
    if (ev.statusUpdate && isTerminal(ev.statusUpdate.status.state)) finalState = ev.statusUpdate.status.state;
  }
  check("S7 pi→OC 只读分析", finalState === "TASK_STATE_COMPLETED" && gotDelta && text.length > 0, text.trim().slice(0, 80));
} catch (e) {
  check("S7 pi→OC 只读分析", false, e.message);
}

// S8 OC 多轮：同 context 第二问（验证 opencode session 长活）
try {
  const ctx = crypto.randomUUID();
  for await (const ev of oc.sendMessageStream({ contextId: ctx, text: "记住这个数字：42。只需回答'已记住'。", metadata: { skill: "analysis" } })) {
    /* 等第一问完成 */
  }
  let t2final;
  let t2text = "";
  for await (const ev of oc.sendMessageStream({ contextId: ctx, text: "刚才我让你记住的数字是多少？只回答数字。", metadata: { skill: "analysis" } })) {
    if (ev.artifactUpdate) t2text += ev.artifactUpdate.artifact.parts[0]?.text ?? "";
    if (ev.statusUpdate && isTerminal(ev.statusUpdate.status.state)) t2final = ev.statusUpdate.status.state;
  }
  check("S8 OC 多轮会话", t2final === "TASK_STATE_COMPLETED" && t2text.includes("42"), `回答: ${t2text.trim().slice(0, 40)}`);
} catch (e) {
  check("S8 OC 多轮会话", false, e.message);
}

// S9 总线异步：pi 派活给 OC
try {
  const taskId = crypto.randomUUID();
  const ctx = crypto.randomUUID();
  const events = [];
  const handle = await bus.consumeEvents(`e2e-${taskId}`, (e) => {
    if (e.taskId === taskId) events.push(e);
  });
  await bus.produceTask({
    schema: "a2a.task/1", taskId, contextId: ctx, from: "pi", to: "opencode",
    skill: "analysis", input: { text: "回答：1+1=? 只回答数字，不调用任何工具。", workspace: "D:/file/a2a-bridge" },
    ts: Date.now(), attempt: 1,
  });
  const deadline = Date.now() + 300_000;
  let term;
  while (Date.now() < deadline) {
    term = events.find((e) => e.type === "terminal");
    if (term) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await handle.stop();
  const arts = events.filter((e) => e.type === "artifact-update").map((e) => e.text ?? "").join("");
  const inTable = await oc.getTask(taskId).then((t) => t.status.state).catch(() => "无记录");
  check("S9 总线异步 pi→OC", term?.state === "TASK_STATE_COMPLETED" && arts.includes("2"), `事件终态=${term?.state} 任务表=${inTable} 事件数=${events.length}`);
} catch (e) {
  check("S9 总线异步 pi→OC", false, e.message);
}

// S10 三 agent 互调：OC（bridge-coding 有 bash）经 bridge CLI 调 CC
try {
  let text = "";
  let finalState;
  for await (const ev of oc.sendMessageStream({
    text: "执行命令: node cli/dispatch.mjs --to claude-code --skill code-review --input '回答：2+3=? 只回答数字，不调用工具。' 然后把命令输出的 result 字段值原样告诉我。",
    metadata: { skill: "coding", workspace: "D:/file/a2a-bridge" },
  })) {
    if (ev.artifactUpdate) text += ev.artifactUpdate.artifact.parts[0]?.text ?? "";
    if (ev.statusUpdate && isTerminal(ev.statusUpdate.status.state)) finalState = ev.statusUpdate.status.state;
  }
  check("S10 OC→CC 互调（经 bridge CLI）", finalState === "TASK_STATE_COMPLETED" && text.includes("5"), text.trim().slice(0, 80));
} catch (e) {
  check("S10 OC→CC 互调（经 bridge CLI）", false, e.message);
}

// S11 权限配置完备性（静态）：headless 下缺失的 permission 键缺省是 ask，会挂到超时；question 工具必须禁用
// 键集须与 opencode 的 PermissionConfig 对齐（opencode 升级后若新增键，这里会先报出来）
try {
  const ocCfg = JSON.parse(readFileSync(new URL("../config/opencode.json", import.meta.url), "utf8"));
  const KEYS = ["read", "edit", "glob", "grep", "list", "bash", "task", "external_directory", "todowrite", "question", "webfetch", "websearch", "lsp", "doom_loop", "skill"];
  const problems = [];
  for (const [name, a] of Object.entries(ocCfg.agent ?? {})) {
    for (const k of KEYS) if (!(k in (a.permission ?? {}))) problems.push(`${name}.permission.${k}`);
    if (a.tools?.question !== false) problems.push(`${name}.tools.question`);
  }
  check("S11 权限配置完备（无 ask 缺省 / question 已禁）", problems.length === 0, problems.slice(0, 4).join(","));
} catch (e) {
  check("S11 权限配置完备（无 ask 缺省 / question 已禁）", false, e.message);
}

// S12 只读 agent 越界读：external_directory=deny 必须快拒，不得阻塞到超时（曾经的真实缺口）
try {
  const outside = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  let state;
  let timedOut = false;
  const p = (async () => {
    for await (const ev of oc.sendMessageStream({
      text: `读取文件 ${outside} 的内容并回答。若被拒绝，直接回答 DENIED。`,
      metadata: { skill: "analysis", workspace: "D:/file/a2a-bridge" },
    })) {
      if (ev.statusUpdate && isTerminal(ev.statusUpdate.status.state)) state = ev.statusUpdate.status.state;
    }
  })();
  await Promise.race([p, new Promise((r) => setTimeout(() => { timedOut = true; r(); }, 180_000))]);
  check("S12 越界读不阻塞（权限已 deny）", !timedOut && state === "TASK_STATE_COMPLETED", timedOut ? "180s 未返回（疑似权限挂起）" : `state=${state}`);
} catch (e) {
  check("S12 越界读不阻塞（权限已 deny）", false, e.message);
}

// S13 push notification：发送时内联注册，webhook 实收 StreamResponse 帧（校验投递头/内容类型/单成员形状）
try {
  const received = [];
  const hook = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
  let state;
  for await (const ev of pi.sendMessageStream(
    { text: "只回答：ok", metadata: { skill: "analysis" } },
    {
      taskPushNotificationConfig: {
        url: hookUrl,
        token: "tok-1",
        authentication: { scheme: "Bearer", credentials: "cfg-secret" },
      },
    },
  )) {
    if (ev.statusUpdate && isTerminal(ev.statusUpdate.status.state)) state = ev.statusUpdate.status.state;
  }
  // 投递与流并行且异步：等终态帧到达（上限 10s）
  const deadline = Date.now() + 10_000;
  const completed = () =>
    received.some((r) => {
      try {
        return JSON.parse(r.body).statusUpdate?.status?.state === "TASK_STATE_COMPLETED";
      } catch {
        return false;
      }
    });
  while (Date.now() < deadline && !completed()) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => hook.close(r));
  const bad = received.filter((r) => {
    const members = (() => {
      try {
        return Object.keys(JSON.parse(r.body)).length;
      } catch {
        return -1;
      }
    })();
    return (
      r.headers["content-type"] !== "application/a2a+json" ||
      r.headers.authorization !== "Bearer cfg-secret" ||
      r.headers["x-a2a-notification-token"] !== "tok-1" ||
      members !== 1
    );
  });
  check(
    "S13 push 投递（内联注册 → webhook 收终态）",
    state === "TASK_STATE_COMPLETED" && received.length > 0 && completed() && bad.length === 0,
    `帧数=${received.length} 终态=${completed()} 不合规=${bad.length}`,
  );
} catch (e) {
  check("S13 push 投递（内联注册 → webhook 收终态）", false, e.message);
}

// S14 push 配置 4 方法 CRUD + 错误分支（reason 必须可判别）
try {
  const t = await pi.sendMessage({ text: "只回答：x", metadata: { skill: "analysis" } });
  const created = await pi.createTaskPushNotificationConfig({ taskId: t.id, url: "http://127.0.0.1:9/never" });
  const fetched = await pi.getTaskPushNotificationConfig({ taskId: t.id, id: created.id });
  const listed = await pi.listTaskPushNotificationConfigs({ taskId: t.id });
  const err = async (p) =>
    p.then(() => "").catch((e) => e.message);
  const unknownTask = await err(pi.createTaskPushNotificationConfig({ taskId: crypto.randomUUID(), url: "http://127.0.0.1:9/x" }));
  const noUrl = await err(pi.createTaskPushNotificationConfig({ taskId: t.id }));
  await pi.deleteTaskPushNotificationConfig({ taskId: t.id, id: created.id });
  const afterDelete = await err(pi.getTaskPushNotificationConfig({ taskId: t.id, id: created.id }));
  const doubleDelete = await err(pi.deleteTaskPushNotificationConfig({ taskId: t.id, id: created.id }));
  const ok =
    Boolean(created.id) &&
    created.taskId === t.id &&
    fetched.id === created.id &&
    fetched.url === "http://127.0.0.1:9/never" &&
    listed.configs.length === 1 &&
    unknownTask.includes("TASK_NOT_FOUND") &&
    noUrl.includes("INVALID_ARGUMENT") &&
    afterDelete.includes("TASK_NOT_FOUND") &&
    doubleDelete.includes("TASK_NOT_FOUND");
  check("S14 push 配置 4 方法 CRUD + 错误分支", ok, `id=${created.id?.slice(0, 8)} list=${listed.configs.length} 错误=${[unknownTask, noUrl, afterDelete].map((s) => s.match(/\((\w+)\)/)?.[1] ?? "?").join("/")}`);
} catch (e) {
  check("S14 push 配置 4 方法 CRUD + 错误分支", false, e.message);
}

// S15 能力开关：未声明 pushNotifications 的实例必须拒绝 4 个方法（PushNotificationNotSupportedError）
try {
  const port = 9399;
  const stub = createA2AServer({
    port,
    apiKey: "",
    card: {
      name: "no-push-stub",
      description: "能力开关测试用",
      supportedInterfaces: [{ url: `http://127.0.0.1:${port}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      version: "0.0.1",
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
    },
    executor: { onMessage: async () => {} },
  });
  await stub.ready;
  const stubClient = new A2AClient(`http://127.0.0.1:${port}/`);
  const msgs = [];
  for (const call of [
    () => stubClient.createTaskPushNotificationConfig({ taskId: "t", url: "http://127.0.0.1:9/x" }),
    () => stubClient.getTaskPushNotificationConfig({ taskId: "t", id: "c" }),
    () => stubClient.listTaskPushNotificationConfigs({ taskId: "t" }),
    () => stubClient.deleteTaskPushNotificationConfig({ taskId: "t", id: "c" }),
  ]) {
    msgs.push(await call().then(() => "").catch((e) => e.message));
  }
  await new Promise((r) => stub.close().then(r));
  check(
    "S15 能力开关（未声明 → PushNotificationNotSupportedError）",
    msgs.every((m) => m.includes("-32003") && m.includes("PushNotificationNotSupportedError")),
    msgs[0]?.slice(0, 60),
  );
} catch (e) {
  check("S15 能力开关（未声明 → PushNotificationNotSupportedError）", false, e.message);
}

// S16 总线任务 + push 配置：总线任务必须落在 A2A 任务表（否则 GetTask/push 配置对其不可见）
// 取消路径是确定性的（终态帧必然产出），自然跑完的终态投递由 S13 与人工实测覆盖
try {
  const received = [];
  const hook = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push({});
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
  const taskId = crypto.randomUUID();
  await bus.produceTask({
    schema: "a2a.task/1", taskId, contextId: crypto.randomUUID(), from: "pi", to: "opencode",
    skill: "analysis", input: { text: "用两三句话说明 A2A 任务有哪些状态。", workspace: "D:/file/a2a-bridge" },
    ts: Date.now(), attempt: 1,
  });
  // 任务由网关消费时才落库：有界重试等待其出现
  let registered;
  for (let i = 0; i < 60 && !registered; i++) {
    registered = await oc.createTaskPushNotificationConfig({ taskId, url: hookUrl, token: "bus-tok" }).catch(() => undefined);
    if (!registered) await new Promise((r) => setTimeout(r, 500));
  }
  const visible = registered ? await oc.getTask(taskId).then((t) => t.status.state).catch(() => "TASK_NOT_FOUND") : "TASK_NOT_FOUND";
  await oc.cancelTask(taskId).catch(() => {});
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !received.some((f) => f.statusUpdate?.status?.state === "TASK_STATE_CANCELED")) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => hook.close(r));
  const gotCanceled = received.some((f) => f.statusUpdate?.status?.state === "TASK_STATE_CANCELED");
  check(
    "S16 总线任务 push（落表 + 注册 + 取消投递）",
    Boolean(registered) && visible !== "TASK_NOT_FOUND" && gotCanceled,
    `task=${visible} 帧数=${received.length} 取消帧=${gotCanceled}`,
  );
} catch (e) {
  check("S16 总线任务 push（落表 + 注册 + 取消投递）", false, e.message);
}

// S17 失败任务不阻塞后续：持续失败 → 重投 3 次 → DLQ → 消费者继续消费（pending-fix-2 回归）
// 语义：handler 异常由总线包装层接住（重试 +1 重投 / 耗尽入 DLQ），卡死或失败的任务不得停摆该 agent 消费；
// 基础设施级崩溃（broker 故障等）由 runWithRecovery 重建，日志可见。
try {
  const got = [];
  let bombCalls = 0;
  let helloOk = false;
  let afterOk = false;
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => {
    logs.push(a.map(String).join(" "));
    origErr(...a);
  };
  try {
    const crashy = await bus.consumeTasks("crashy", "crashy-gw", async (task) => {
      if (task.input.text.includes("BOMB")) {
        bombCalls++;
        throw new Error(`boom（第 ${task.attempt ?? 1} 次）`);
      }
      got.push(task.input.text);
    });
    const toCrashy = (text) =>
      bus.produceTask({
        schema: "a2a.task/1", taskId: crypto.randomUUID(), contextId: crypto.randomUUID(),
        from: "pi", to: "crashy", skill: "x", input: { text }, ts: Date.now(), attempt: 1,
      });
    await toCrashy("hello");
    helloOk = await waitUntil(() => got.includes("hello"), 30_000);
    await toCrashy("BOMB");
    await toCrashy("after");
    afterOk = await waitUntil(() => got.includes("after"), 90_000);
    await crashy.stop();
  } finally {
    console.error = origErr;
  }
  const sawFailLog = logs.some((l) => l.includes("[bus]") && l.includes("taskId="));
  check(
    "S17 失败任务不阻塞后续（重投→DLQ→继续消费）",
    helloOk && afterOk && sawFailLog && bombCalls >= 3,
    `consumed=[${got.join(",")}] bombCalls=${bombCalls} 失败日志=${sawFailLog}`,
  );
} catch (e) {
  check("S17 失败任务不阻塞后续（重投→DLQ→继续消费）", false, e.message);
}

// S18 卡死任务不阻塞后续：超时落 FAILED → 继续消费（pending-fix-3 回归）
try {
  const port = 9340;
  const stub = createA2AServer({
    port,
    apiKey: "",
    card: {
      name: "hang-stub",
      description: "e2e 卡死任务测试",
      supportedInterfaces: [{ url: `http://127.0.0.1:${port}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      version: "0.0.1",
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
    },
    taskTimeoutMs: 8000,
    executor: {
      onMessage: async (ctx) => {
        if (ctx.text.includes("HANG")) return new Promise(() => {}); // 永不 resolve
        ctx.sink.appendArtifact("reply", "reply", "ok", true);
      },
    },
  });
  await stub.ready;
  const stubConsumer = await bus.consumeTasks("hang-stub", "hang-stub-gw", async (task) => {
    const session = stub.attachTask({ taskId: task.taskId, contextId: task.contextId });
    try {
      const t = await stub.executeTask({
        taskId: task.taskId, contextId: task.contextId, skill: "x", text: task.input.text, metadata: {},
      }, session);
      await bus.produceEvent({
        schema: "a2a.event/1", taskId: task.taskId, contextId: task.contextId, from: "hang-stub",
        type: "terminal", state: t.status.state, final: true, ts: Date.now(),
      });
    } catch {
      /* executeTask 理论不抛；兑底防消费者静默停摆 */
    }
  }, { taskTimeoutMs: 8000 });
  const t1 = crypto.randomUUID();
  const t2 = crypto.randomUUID();
  const toStub = (id, text) =>
    bus.produceTask({
      schema: "a2a.task/1", taskId: id, contextId: crypto.randomUUID(),
      from: "pi", to: "hang-stub", skill: "x", input: { text }, ts: Date.now(), attempt: 1,
    });
  await toStub(t1, "HANG");
  await toStub(t2, "ping");
  const stubClient = new A2AClient(`http://127.0.0.1:${port}/`);
  // 预期：T1 卡满 8s 超时落 FAILED，T2 随后被消费完成（无需重启）
  const t2Ok = await waitUntil(async () => (await stubClient.getTask(t2).catch(() => null))?.status.state === "TASK_STATE_COMPLETED", 60_000);
  const t1Failed = await waitUntil(async () => (await stubClient.getTask(t1).catch(() => null))?.status.state === "TASK_STATE_FAILED", 10_000);
  const t1State = (await stubClient.getTask(t1).catch(() => null))?.status.state ?? "无";
  const t2State = (await stubClient.getTask(t2).catch(() => null))?.status.state ?? "无";
  await stubConsumer.stop();
  await new Promise((r) => stub.close().then(r));
  check(
    "S18 卡死任务不阻塞后续（超时→FAILED→继续消费）",
    t2Ok && t1Failed,
    `T1=${t1State} T2=${t2State}`,
  );
} catch (e) {
  check("S18 卡死任务不阻塞后续（超时→FAILED→继续消费）", false, e.message);
}

// S19 returnImmediately：秒级返回（不等执行完），任务随后自行落终态（pending-fix-5 回归）
try {
  const port = 9341;
  const stub2 = createA2AServer({
    port,
    apiKey: "",
    card: {
      name: "ri-stub",
      description: "e2e returnImmediately 测试",
      supportedInterfaces: [{ url: `http://127.0.0.1:${port}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      version: "0.0.1",
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
    },
    taskTimeoutMs: 30_000,
    executor: {
      onMessage: async (ctx) => {
        await new Promise((r) => setTimeout(r, 3000)); // 模拟慢执行
        ctx.sink.appendArtifact("reply", "reply", "done", true);
      },
    },
  });
  await stub2.ready;
  const c2 = new A2AClient(`http://127.0.0.1:${port}/`);
  const t0 = Date.now();
  const res = await c2.sendMessage({ text: "slow" }, 3000, { returnImmediately: true });
  const elapsed = Date.now() - t0;
  const initial = res.status.state;
  const completed = await waitUntil(async () => (await c2.getTask(res.id).catch(() => null))?.status.state === "TASK_STATE_COMPLETED", 15_000);
  await new Promise((r) => stub2.close().then(r));
  check("S19 returnImmediately（秒级返回 + 自行落终态）", elapsed < 2000 && !isTerminal(initial) && completed, `返回=${elapsed}ms 初始=${initial}`);
} catch (e) {
  check("S19 returnImmediately（秒级返回 + 自行落终态）", false, e.message);
}

const stubCard = (port, name) => ({
  name,
  description: "e2e stub",
  supportedInterfaces: [{ url: `http://127.0.0.1:${port}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  version: "0.0.1",
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [],
});

// S20 鉴权：401 用 -32010 UnauthorizedError（非 -32001 TaskNotFound 语义）；非回环无 key fail-closed
try {
  const port = 9398;
  const stub = createA2AServer({ port, apiKey: "k1", card: stubCard(port, "auth-stub"), executor: { onMessage: async () => {} } });
  await stub.ready;
  const anonRes = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "nope" } }),
  });
  const anon = await anonRes.json();
  let okWithKey = false;
  try {
    await new A2AClient(`http://127.0.0.1:${port}/`, "k1").listTasks();
    okWithKey = true;
  } catch {
    /* 带 key 也应成功 */
  }
  let nonLoopback = false;
  try {
    createA2AServer({ port: 9397, host: "0.0.0.0", apiKey: "", card: stubCard(9397, "x"), executor: { onMessage: async () => {} } });
  } catch (e) {
    nonLoopback = /apiKey/.test(String(e.message));
  }
  await stub.close();
  check(
    "S20 鉴权（401→-32010 UnauthorizedError / 非回环无 key 直接抛错）",
    anonRes.status === 401 && anon.error?.code === -32010 && JSON.stringify(anon.error?.data).includes("UnauthorizedError") && okWithKey && nonLoopback,
    `status=${anonRes.status} code=${anon.error?.code}`,
  );
} catch (e) {
  check("S20 鉴权（401→-32010 UnauthorizedError / 非回环无 key 直接抛错）", false, e.message);
}

// S21 close：有未结束的 SSE 流时 close() 必须 resolve（此前 server.close() 会等 SSE 永不返回）
try {
  const port = 9396;
  const stub = createA2AServer({
    port,
    apiKey: "",
    card: stubCard(port, "close-stub"),
    taskTimeoutMs: 30_000,
    executor: {
      onMessage: async (ctx) => {
        ctx.sink.sendStatus("TASK_STATE_WORKING");
        await new Promise((r) => setTimeout(r, 5000)); // 长任务：SSE 流不会自然结束
        ctx.sink.appendArtifact("reply", "reply", "done", true);
      },
    },
  });
  await stub.ready;
  const c = new A2AClient(`http://127.0.0.1:${port}/`);
  const gen = c.sendMessageStream({ text: "slow" });
  await gen.next(); // 首帧（task 快照）= SSE 流已打开
  const t0 = Date.now();
  await stub.close();
  const dt = Date.now() - t0;
  await gen.return(undefined).catch(() => {});
  check("S21 close 在活跃 SSE 下 resolve（≤2s）", dt < 2000, `dt=${dt}ms`);
} catch (e) {
  check("S21 close 在活跃 SSE 下 resolve（≤2s）", false, e.message);
}

// S22 SSE 截断：流在未发终态帧时断开，客户端必须报错（不静默当成功/空流）
try {
  const srv = http.createServer((req, res) => {
    if (req.method !== "POST") return res.end();
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ task: { id: "t1", contextId: "c1", status: { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() } } })}\n\n`);
    req.on("end", () => res.destroy()); // 不发终态帧直接断连
  });
  srv.listen(9395, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const c = new A2AClient("http://127.0.0.1:9395/");
  let threw = "";
  try {
    for await (const _ of c.sendMessageStream({ text: "x" })) {
      /* 消费 */
    }
  } catch (e) {
    threw = String(e.message);
  }
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  check("S22 SSE 截断上报（无终态帧）", threw.includes("流中断"), `threw=${threw.slice(0, 60)}`);
} catch (e) {
  check("S22 SSE 截断上报（无终态帧）", false, e.message);
}

// S23 CLI 入口解析：Windows 下必须落到真实 .exe（npm shim 首行是无扩展名 sh，走 cmd 包装层会让进程树杀不干净）
try {
  const oc2 = resolveCliBin("opencode", undefined);
  const cl2 = resolveCliBin("claude", undefined);
  const isExe = (b) => process.platform !== "win32" || b.cmd.toLowerCase().endsWith(".exe");
  const envOverride = resolveCliBin("opencode", "C:/fake/opencode.exe").cmd === "C:/fake/opencode.exe";
  check("S23 CLI 入口解析到真实可执行文件", isExe(oc2) && isExe(cl2) && envOverride, `opencode=${oc2.cmd} claude=${cl2.cmd}`);
} catch (e) {
  check("S23 CLI 入口解析到真实可执行文件", false, e.message);
}

// S24 kill() 终止整棵进程树：startOcServer → kill 后其随机端口必须释放（原包装层下 opencode.exe 成孤儿继续 LISTENING）
try {
  const ws = path.join(os.tmpdir(), `a2a-e2e-oc-kill-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const srv = await startOcServer(ws, path.resolve("config/opencode.json"));
  const port = Number(new URL(srv.url).port);
  srv.kill();
  const freed = await waitUntil(async () => !(await portOpen(port)), 10_000);
  check("S24 kill 终止进程树（端口释放）", freed, `port=${port} 释放=${freed}`);
} catch (e) {
  check("S24 kill 终止进程树（端口释放）", false, e.message);
}

await piGw.close();
await ccGw.close();
await ocGw.close();
await bus.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
