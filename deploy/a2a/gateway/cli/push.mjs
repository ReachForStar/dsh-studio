#!/usr/bin/env node
// push notification 配置管理（A2A v1.0.1 的 4 个方法）。
// 用法:
//   node cli/push.mjs create --to pi --task <taskId> --url <webhook> [--token t] [--auth "Bearer x"]
//   node cli/push.mjs get    --to pi --task <taskId> --id <configId>
//   node cli/push.mjs list   --to pi --task <taskId>
//   node cli/push.mjs delete --to pi --task <taskId> --id <configId>
import { A2AClient, loadConfig } from "@a2a-bridge/shared";
import process from "node:process";

function get(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`缺少参数值: --${name}`);
  return v;
}

const cmd = process.argv[2];
const to = get("to");
const taskId = get("task");
if (!cmd || !to || !taskId || !["create", "get", "list", "delete"].includes(cmd)) {
  console.error("用法: push.mjs <create|get|list|delete> --to <pi|claude-code|opencode> --task <taskId> [--url <webhook>] [--id <configId>] [--token <t>] [--auth \"<scheme> <credentials>\"]");
  process.exit(2);
}

const cfg = loadConfig();
const port = cfg.agents[to]?.port;
if (!port) throw new Error(`未知 agent: ${to}（可用: ${Object.keys(cfg.agents).join(", ")}）`);
const client = new A2AClient(`http://127.0.0.1:${port}/`, cfg.apiKey || undefined);

/** "Bearer abc" → {scheme:"Bearer", credentials:"abc"}（缺 credentials 时仅 scheme） */
function authOf(spec) {
  if (!spec) return undefined;
  const [scheme, ...rest] = spec.trim().split(/\s+/);
  return { scheme, ...(rest.length ? { credentials: rest.join(" ") } : {}) };
}

if (cmd === "create") {
  const url = get("url");
  if (!url) throw new Error("create 需要 --url <webhook>");
  const out = await client.createTaskPushNotificationConfig({
    taskId,
    url,
    ...(get("token") ? { token: get("token") } : {}),
    ...(authOf(get("auth")) ? { authentication: authOf(get("auth")) } : {}),
  });
  console.log(JSON.stringify(out, null, 2));
} else if (cmd === "get") {
  const id = get("id");
  if (!id) throw new Error("get 需要 --id <configId>");
  console.log(JSON.stringify(await client.getTaskPushNotificationConfig({ taskId, id }), null, 2));
} else if (cmd === "list") {
  console.log(JSON.stringify(await client.listTaskPushNotificationConfigs({ taskId }), null, 2));
} else {
  const id = get("id");
  if (!id) throw new Error("delete 需要 --id <configId>");
  await client.deleteTaskPushNotificationConfig({ taskId, id });
  console.log(JSON.stringify({ deleted: id, taskId }));
}
