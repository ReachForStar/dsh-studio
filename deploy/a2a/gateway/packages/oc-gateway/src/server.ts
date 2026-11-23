// opencode 网关：A2A server（opencode serve 执行）+ 总线消费
import { createA2AServer, isTerminal, textOf, type A2AExecutor, type A2AServer, type StreamSink, type TaskSession } from "@a2a-bridge/shared";
import type { AgentCard, BridgeConfig, BusTask, Bus } from "@a2a-bridge/shared";
import { startOcServer, buildEffectiveOcConfig, resolveOcModel, type OcServer } from "./opencode.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const OC_CARD: AgentCard = {
  name: "opencode-agent",
  description: "opencode 代理：代码审查、编码与只读分析（执行方）",
  supportedInterfaces: [
    { url: "http://127.0.0.1:9330/", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
  version: "0.1.0",
  capabilities: { streaming: true, pushNotifications: true },
  skills: [
    { id: "code-review", name: "代码审查", description: "只读审查 diff/代码，输出问题清单", tags: ["review"] },
    { id: "coding", name: "编码", description: "在指定工作区修改代码、跑测试", tags: ["coding"] },
    { id: "analysis", name: "调研分析", description: "只读调研、排查、方案分析", tags: ["analysis"] },
  ],
  securitySchemes: {
    apiKey: { apiKeySecurityScheme: { location: "header", name: "X-Api-Key" } },
  },
  securityRequirements: [{ schemes: { apiKey: { list: [] } } }],
  defaultInputModes: ["application/json", "text/plain"],
  defaultOutputModes: ["text/plain"],
};

/** 每 workspace 一个长活 opencode serve；session 由 contextId 映射（多会话共享同一 server 进程） */
class OcRegistry {
  private servers = new Map<string, OcServer>();
  constructor(private idleMs: number, private configPath: string) {
    const t = setInterval(() => this.sweep(), 60_000);
    t.unref();
  }
  async get(workspace: string): Promise<OcServer> {
    const s = this.servers.get(workspace);
    if (s) return s;
    const ns = await startOcServer(workspace, this.configPath);
    this.servers.set(workspace, ns);
    return ns;
  }
  releaseSession(workspace: string, contextId: string): void {
    this.servers.get(workspace)?.releaseSession(contextId);
  }
  private sweep(): void {
    const now = Date.now();
    for (const [ws, s] of this.servers) {
      // 会话空闲回收 + 无活动的 server 进程回收
      for (const [cid, sess] of [...s.sessions]) {
        if (now - sess.lastUsed > this.idleMs) s.releaseSession(cid);
      }
      if (now - s.lastUsed > this.idleMs) {
        s.kill();
        this.servers.delete(ws);
      }
    }
  }
  releaseAll(): void {
    for (const [ws, s] of [...this.servers]) {
      s.kill();
      this.servers.delete(ws);
    }
  }
}

function sinkToBus(bus: Bus, self: string, taskId: string, contextId: string): StreamSink {
  return {
    sendStatus(state, text?) {
      void bus.produceEvent({
        schema: "a2a.event/1", taskId, contextId, from: self,
        type: "status-update", state, text, ts: Date.now(),
      });
    },
    appendArtifact(artifactId, name, text, lastChunk) {
      void bus.produceEvent({
        schema: "a2a.event/1", taskId, contextId, from: self,
        type: "artifact-update", artifact: artifactId, text, final: lastChunk, ts: Date.now(),
      });
    },
  };
}

/** bridge 专用 agent 定义文件（config/opencode.json，随仓库提交）：经 OPENCODE_CONFIG 注入 */
function ocConfigPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../config/opencode.json");
}

export interface OcGateway {
  server: A2AServer;
  close(): Promise<void>;
}

export async function startOcGateway(cfg: BridgeConfig, bus: Bus): Promise<OcGateway> {
  const agentName = "opencode";
  // 模型来源：bridge 配置优先，为空则读 opencode 全局配置的 model（见 resolveOcModel）
  const ocModel = resolveOcModel(cfg.opencodeModel);
  // agent 定义（仓库）+ 自定义 provider 强制 chat completions（临时文件，不含密钥）
  const registry = new OcRegistry(cfg.idleMs, buildEffectiveOcConfig(ocConfigPath(), ocModel));
  const agentFor = (skill: string): string =>
    cfg.opencodeSkillAgents[skill] ?? cfg.opencodeSkillAgents.coding ?? "bridge-coding";

  const executor: A2AExecutor = {
    async onMessage(ctx) {
      const cwd = ctx.workspace || cfg.agents.opencode.defaultWorkspace;
      const srv = await registry.get(cwd);
      ctx.sink.sendStatus("TASK_STATE_WORKING");
      const res = await srv.sendUserTimed(
        ctx.contextId,
        ctx.text,
        agentFor(ctx.skill),
        ocModel,
        (delta) => ctx.sink.appendArtifact("reply", "reply", delta),
        cfg.taskTimeoutMs,
      );
      if (!res.ok) throw new Error(res.error ?? res.text.slice(0, 2000));
    },
    onCancel({ contextId }) {
      // 取消 = 远端 abort + 切断本地在途 POST（否则 POST /session/{id}/message 一直挂着，消费停摆）
      for (const ws of registryWorkspaces(registry)) {
        const s = (registry as unknown as { servers: Map<string, import("./opencode.js").OcServer> }).servers.get(ws);
        void s?.sessions.get(contextId)?.interrupt().finally(() => registry.releaseSession(ws, contextId));
      }
    },
  };

  const server = createA2AServer({
    port: cfg.agents.opencode.port,
    apiKey: cfg.apiKey,
    card: { ...OC_CARD, supportedInterfaces: [{ url: `http://127.0.0.1:${cfg.agents.opencode.port}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] },
    executor,
    taskTimeoutMs: cfg.taskTimeoutMs,
  });

  // 在途总线任务（taskId → 会话）：onTimeout 从总线侧触发时需要按 taskId 定位会话落终态
  const inflight = new Map<string, TaskSession>();
  // 已被总线超时定终的任务：handler 迟到时不再重发终态事件
  const timedOut = new Set<string>();
  const consumer = await bus.consumeTasks(agentName, `${agentName}-gw`, async (task: BusTask) => {
    // 总线任务也落 A2A 任务表：GetTask/ListTasks 可见，且注册的 push webhook 能收到事件
    const session = server.attachTask({ taskId: task.taskId, contextId: task.contextId, metadata: task.metadata });
    // 在任何 await 之前同步登记：onTimeout（定时器回调）依赖它定位会话
    inflight.set(task.taskId, session);
    try {
      const ctx = {
        taskId: task.taskId,
        contextId: task.contextId,
        skill: task.skill,
        workspace: task.input.workspace,
        text: task.input.text,
        metadata: task.metadata ?? {},
        // executeTask 内部 sink 已扇出到 session.sink（任务表+广播）与 ctx.sink（总线事件）；
        // 这里再 tee 进 session.sink 会把同一帧广播两遍（SSE/push 收重复帧）
        sink: sinkToBus(bus, agentName, task.taskId, task.contextId),
      };
      // 走 executeTask：单任务超时（taskTimeoutMs）+ CancelTask 可中断总线任务，终态统一由会话落
      const t = await server.executeTask(ctx, session);
      if (!timedOut.has(task.taskId)) {
        await bus.produceEvent({
          schema: "a2a.event/1", taskId: task.taskId, contextId: task.contextId, from: agentName,
          type: "terminal",
          state: t.status.state,
          error: t.status.state === "TASK_STATE_FAILED" ? (t.status.message ? textOf(t.status.message.parts) : "failed") : undefined,
          final: true, ts: Date.now(),
        });
      }
    } finally {
      inflight.delete(task.taskId);
      timedOut.delete(task.taskId);
    }
  }, {
    taskTimeoutMs: cfg.taskTimeoutMs,
    onTimeout: (task) => {
      const t = server.store.get(task.taskId);
      if (!t || isTerminal(t.status.state)) return; // 已取消/已终态，不覆盖
      timedOut.add(task.taskId);
      const err = new Error(`任务执行超时 (${cfg.taskTimeoutMs}ms)`);
      inflight.get(task.taskId)?.fail(err); // 任务表落 FAILED + 广播（SSE/push）
      void bus.produceEvent({
        schema: "a2a.event/1", taskId: task.taskId, contextId: task.contextId, from: agentName,
        type: "terminal", state: "TASK_STATE_FAILED", error: `任务执行超时 (${cfg.taskTimeoutMs}ms)`, final: true, ts: Date.now(),
      });
    },
  });

  return {
    server,
    async close() {
      await consumer.stop();
      registry.releaseAll();
      await server.close();
    },
  };
}

// 仅用于 onCancel：registry 内部 Map 不暴露
function registryWorkspaces(registry: OcRegistry): string[] {
  return [...(registry as unknown as { servers: Map<string, unknown> }).servers.keys()];
}
