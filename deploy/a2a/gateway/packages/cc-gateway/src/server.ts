// Claude Code 网关：A2A server（claude -p 执行）+ 总线消费
import { createA2AServer, isTerminal, textOf, type A2AExecutor, type A2AServer, type StreamSink, type TaskSession } from "@a2a-bridge/shared";
import type { AgentCard, BridgeConfig, BusEvent, BusTask, Bus } from "@a2a-bridge/shared";
import { spawnClaudeSession, type ClaudeSession } from "./claude-session.js";

export const CC_CARD: AgentCard = {
  name: "claude-code-agent",
  description: "Claude Code 代理：代码审查与编码（执行方）",
  supportedInterfaces: [
    { url: "http://127.0.0.1:9320/", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
  version: "0.1.0",
  capabilities: { streaming: true, pushNotifications: true },
  skills: [
    { id: "code-review", name: "代码审查", description: "只读审查 diff/代码，输出问题清单", tags: ["review"] },
    { id: "coding", name: "编码", description: "在指定工作区修改代码、跑测试", tags: ["coding"] },
  ],
  securitySchemes: {
    apiKey: { apiKeySecurityScheme: { location: "header", name: "X-Api-Key" } },
  },
  securityRequirements: [{ schemes: { apiKey: { list: [] } } }],
  defaultInputModes: ["application/json", "text/plain"],
  defaultOutputModes: ["text/plain"],
};

class ClaudeRegistry {
  private sessions = new Map<string, { sess: ClaudeSession; cwd: string }>();
  constructor(private idleMs: number) {
    const t = setInterval(() => this.sweep(), 60_000);
    t.unref();
  }
  get(contextId: string, workspace: string, tools: string[]): ClaudeSession {
    const e = this.sessions.get(contextId);
    if (e) {
      if (e.cwd === workspace) return e.sess;
      e.sess.kill(); // workspace 变了，旧进程 cwd 不对，重建
    }
    const ns = spawnClaudeSession(workspace, tools);
    ns.kill = () => {
      // kill 后从注册表移除，下次重建
      this.sessions.delete(contextId);
    };
    this.sessions.set(contextId, { sess: ns, cwd: workspace });
    return ns;
  }
  release(contextId: string): void {
    this.sessions.get(contextId)?.sess.kill();
    this.sessions.delete(contextId);
  }
  private sweep(): void {
    const now = Date.now();
    for (const [id, e] of this.sessions) {
      if (now - e.sess.lastUsed > this.idleMs) e.sess.kill();
    }
  }
  releaseAll(): void {
    for (const id of [...this.sessions.keys()]) this.release(id);
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

export interface CcGateway {
  server: A2AServer;
  close(): Promise<void>;
}

export async function startCcGateway(cfg: BridgeConfig, bus: Bus): Promise<CcGateway> {
  const agentName = "claude-code";
  const registry = new ClaudeRegistry(cfg.idleMs);
  const toolsFor = (skill: string): string[] =>
    cfg.claudeSkillTools[skill] ?? cfg.claudeSkillTools["code-review"] ?? [];

  const executor: A2AExecutor = {
    async onMessage(ctx) {
      const cwd = ctx.workspace || cfg.agents["claude-code"].defaultWorkspace;
      const sess = registry.get(ctx.contextId, cwd, toolsFor(ctx.skill));
      ctx.sink.sendStatus("TASK_STATE_WORKING");
      const res = await sess.sendUser(
        ctx.text,
        (delta) => ctx.sink.appendArtifact("reply", "reply", delta),
        cfg.taskTimeoutMs,
      );
      if (!res.ok) throw new Error(res.resultText.slice(0, 2000));
      // result 文本是最终答案；流式 delta 已覆盖大部分，兜底确保 artifact 非空
    },
    onCancel({ contextId }) {
      registry.release(contextId);
    },
  };

  const server = createA2AServer({
    port: cfg.agents["claude-code"].port,
    apiKey: cfg.apiKey,
    card: { ...CC_CARD, supportedInterfaces: [{ url: `http://127.0.0.1:${cfg.agents["claude-code"].port}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] },
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
