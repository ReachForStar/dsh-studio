import { fileURLToPath } from "node:url";
import { loadConfig, createBus } from "@a2a-bridge/shared";
import { startPiGateway, PI_CARD } from "./server.js";
import type { PiGateway } from "./server.js";

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const bus = createBus(cfg.bus);
  await bus.ensureTopics();
  const gw = await startPiGateway(cfg, bus);
  await gw.server.ready; // 端口真正 bind 成功才算启动完成
  console.log(`[pi-gateway] A2A server 已启动 http://127.0.0.1:${cfg.agents.pi.port}/ (agent card: /.well-known/agent-card.json)`);
  if (cfg.piModel) console.log(`[pi-gateway] 配置模型: ${cfg.piModel}（实际模型在首个任务时打印 [pi] 会话模型）`);
  console.log(`[pi-gateway] 总线已订阅 ${cfg.bus.taskTopic} (group=pi-gw)`);
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
      console.error(`[pi-gateway] 端口已被占用: ${msg}`);
      console.error(`[pi-gateway] 多半是旧实例还在运行。排查: netstat -ano | findstr :${cfgPort()} → taskkill /PID <pid> /F 后重启`);
    } else {
      console.error(`[pi-gateway] 启动失败: ${msg}`);
    }
    process.exit(1);
  });
}

function cfgPort(): string {
  return String(loadConfig().agents.pi.port);
}

export { startPiGateway, PI_CARD };
export type { PiGateway };
