// pi 网关：A2A server（pi SDK 执行）+ 总线消费
import { createA2AServer, isTerminal, textOf, type A2AExecutor, type A2AServer, type StreamSink, type TaskSession } from "@a2a-bridge/shared";
import type { AgentCard, BridgeConfig, BusEvent, BusTask } from "@a2a-bridge/shared";
import type { Bus } from "@a2a-bridge/shared";
import { PiSessionRegistry } from "./pi-registry.js";

export const PI_CARD: AgentCard = {
  name: "pi-agent",
  description: "pi 编码代理：仓库开发、维护与知识沉淀（编排方）",
  supportedInterfaces: [
    { url: "http://127.0.0.1:9310/", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
  version: "0.1.0",
  capabilities: { streaming: true, pushNotifications: true },
  skills: [
    { id: "code-dev", name: "代码开发", description: "需求开发、重构、调试、测试", tags: ["coding"] },
    { id: "repo-maintenance", name: "仓库维护", description: "构建、测试、wiki 知识沉淀、git 提交", tags: ["maintenance"] },
    { id: "analysis", name: "调研分析", description: "只读调研、排查、方案分析", tags: ["analysis"] },
  ],
  securitySchemes: {
    apiKey: { apiKeySecurityScheme: { location: "header", name: "X-Api-Key" } },
  },
  securityRequirements: [{ schemes: { apiKey: { list: [] } } }],
  defaultInputModes: ["application/json", "text/plain"],
  defaultOutputModes: ["text/plain"],
};

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

export interface PiGateway {
  server: A2AServer;
  close(): Promise<void>;
}

export async function startPiGateway(cfg: BridgeConfig, bus: Bus): Promise<PiGateway> {
  const agentName = "pi";
  const registry = new PiSessionRegistry(cfg.idleMs, undefined, cfg.piModel || undefined);
  let modelLogged = false;
  const toolsFor = (skill: string): string[] =>
    cfg.piSkillTools[skill] ?? cfg.piSkillTools["code-dev"] ?? ["read", "bash", "edit", "write"];

  const executor: A2AExecutor = {
    async onMessage(ctx) {
      const cwd = ctx.workspace || cfg.agents.pi.defaultWorkspace;
      const session = await registry.get(ctx.contextId, cwd, toolsFor(ctx.skill));
      if (!modelLogged) {
        modelLogged = true;
        const m = session.model as { id?: string; provider?: string; providerId?: string; modelId?: string } | undefined;
        console.error(`[pi] 会话模型: ${m?.provider ?? m?.providerId ?? "?"}/${m?.id ?? m?.modelId ?? "?"}`);
      }
      ctx.sink.sendStatus("TASK_STATE_WORKING");
      // 文本增量 → artifact 流
      const unsub = session.subscribe((ev) => {
        const anyEv = ev as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
        if (anyEv.type === "message_update" && anyEv.assistantMessageEvent?.type === "text_delta" && anyEv.assistantMessageEvent.delta) {
          ctx.sink.appendArtifact("reply", "reply", anyEv.assistantMessageEvent.delta);
        }
      });
      try {
        await session.prompt(ctx.text);
        // prompt 完成 = 终态；若全程无增量（如纯工具调用），从消息历史兜底取最后一条 assistant 文本
        const msgs = (session as unknown as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
        let hasDelta = false;
        for (const m of msgs) {
          const c = m.content;
          if (Array.isArray(c) && c.some((b) => (b as { type?: string }).type === "text")) hasDelta = true;
        }
        if (!hasDelta) {
          const last = [...msgs].reverse().find((m) => m.role === "assistant");
          const text = typeof last?.content === "string" ? (last.content as string) :
            Array.isArray(last?.content)
              ? (last!.content as Array<{ type?: string; text?: string }>)
                  .filter((b) => b.type === "text")
                  .map((b) => b.text ?? "")
                  .join("")
              : "";
          if (text) ctx.sink.appendArtifact("reply", "reply", text, true);
        }
      } finally {
        unsub();
      }
    },
    onCancel({ contextId }) {
      // pi 会话的 abort 通过 prompt 的 Promise reject 生效；这里记录空闲即回收
      registry.release(contextId);
    },
  };

  const server = createA2AServer({
    port: cfg.agents.pi.port,
    apiKey: cfg.apiKey,
    card: { ...PI_CARD, supportedInterfaces: [{ url: `http://127.0.0.1:${cfg.agents.pi.port}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] },
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
      for (const id of [...registryIds(registry)]) registry.release(id);
      await server.close();
    },
  };
}

// 仅用于 close：通过 duck typing 取 keys（registry 内部 Map 不暴露）
function registryIds(registry: PiSessionRegistry): string[] {
  const m = (registry as unknown as { entries: Map<string, unknown> }).entries;
  return [...m.keys()];
}
