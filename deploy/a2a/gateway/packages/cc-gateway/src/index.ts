import { fileURLToPath } from "node:url";
import { loadConfig, createBus } from "@a2a-bridge/shared";
import { startCcGateway, CC_CARD } from "./server.js";
import type { CcGateway } from "./server.js";

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const bus = createBus(cfg.bus);
  await bus.ensureTopics();
  const gw = await startCcGateway(cfg, bus);
  await gw.server.ready; // 端口真正 bind 成功才算启动完成
  console.log(`[cc-gateway] A2A server 已启动 http://127.0.0.1:${cfg.agents["claude-code"].port}/ (agent card: /.well-known/agent-card.json)`);
  console.log(`[cc-gateway] 总线已订阅 ${cfg.bus.taskTopic} (group=claude-code-gw)`);
  const stop = () => {
    void gw.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// 仅直接启动时执行（被 e2e import 时不自动起服务）
const isDirectRun =
  !!process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") === process.argv[1].replace(/\\/g, "/");
if (isDirectRun) {
  void main().catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("EADDRINUSE")) {
      console.error(`[cc-gateway] 端口已被占用: ${msg}`);
      console.error(`[cc-gateway] 多半是旧实例还在运行。排查: netstat -ano | findstr :${cfgPort()} → taskkill /PID <pid> /F 后重启`);
    } else {
      console.error(`[cc-gateway] 启动失败: ${msg}`);
    }
    process.exit(1);
  });
}

function cfgPort(): string {
  return String(loadConfig().agents["claude-code"].port);
}

export { startCcGateway, CC_CARD };
export type { CcGateway };
