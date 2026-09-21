// pi SDK 会话注册表：contextId ↔ AgentSession（文件持久化，可审计）
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

interface Entry {
  session: AgentSession;
  cwd: string;
  lastUsed: number;
}

export class PiSessionRegistry {
  private entries = new Map<string, Entry>();
  private runtimePromise: Promise<ModelRuntime> | undefined;

  constructor(private idleMs: number, private sweepMs = 60_000, private modelSpec?: string) {
    const t = setInterval(() => this.sweep(), this.sweepMs);
    t.unref();
  }

  private runtime(): Promise<ModelRuntime> {
    if (!this.runtimePromise) this.runtimePromise = ModelRuntime.create();
    return this.runtimePromise;
  }

  /** provider/modelId → Model；格式错或模型不存在直接报错（不用默认模型静默顶替） */
  private resolveModel(runtime: ModelRuntime) {
    if (!this.modelSpec) return undefined;
    const [providerId, ...rest] = this.modelSpec.split("/");
    const modelId = rest.join("/");
    if (!providerId || !modelId) throw new Error(`piModel 格式应为 provider/modelId: ${this.modelSpec}`);
    const m = runtime.getModel(providerId, modelId);
    if (!m) throw new Error(`模型不存在: ${this.modelSpec}（检查 ~/.pi/agent/models.json 的 providers）`);
    return m;
  }

  async get(contextId: string, cwd: string, tools: string[]): Promise<AgentSession> {
    const existing = this.entries.get(contextId);
    if (existing && existing.cwd === cwd) {
      existing.lastUsed = Date.now();
      return existing.session;
    }
    const modelRuntime = await this.runtime();
    const model = this.resolveModel(modelRuntime);
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.create(cwd),
      modelRuntime,
      model,
      tools,
    });
    this.entries.set(contextId, { session, cwd, lastUsed: Date.now() });
    return session;
  }

  release(contextId: string): void {
    const e = this.entries.get(contextId);
    if (!e) return;
    e.session.dispose();
    this.entries.delete(contextId);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, e] of this.entries) {
      if (now - e.lastUsed > this.idleMs) {
        e.session.dispose();
        this.entries.delete(id);
      }
    }
  }
}
