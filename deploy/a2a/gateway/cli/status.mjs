#!/usr/bin/env node
// 查询任务状态（A2A tasks/get）
import { A2AClient, loadConfig } from "@a2a-bridge/shared";
import process from "node:process";

const [to, id] = process.argv.slice(2);
if (!to || !id) {
  console.error("用法: status.mjs <pi|claude-code> <taskId>");
  process.exit(2);
}
const cfg = loadConfig();
const task = await new A2AClient(`http://127.0.0.1:${cfg.agents[to].port}/`, cfg.apiKey || undefined).getTask(id);
console.log(JSON.stringify(task, null, 2));
