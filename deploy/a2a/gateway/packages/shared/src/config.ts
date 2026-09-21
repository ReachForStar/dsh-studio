import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface AgentEndpointCfg {
  /** A2A RPC 端口（JSON-RPC over HTTP） */
  port: number;
  /** 默认工作区（任务未带 workspace 时使用） */
  defaultWorkspace: string;
}

export interface BusCfg {
  bootstrapServers: string[];
  taskTopic: string;
  eventTopic: string;
  dlqTopic: string;
  partitions: number;
  maxAttempts: number;
  /**
   * kafkajs 消费者重试策略（处理器异常/连接失败后重试）：缺省用 kafkajs 默认（10 次 ~1min）；
   * 调小可加快 crash→重建路径。键名与 kafkajs RetryOptions 对齐。
   */
  retry?: { maxRetryTime?: number; initialRetryTime?: number; factor?: number; multiplier?: number; retries?: number };
}

export interface PiSkillTools {
  [skill: string]: string[];
}

export interface ClaudeSkillTools {
  [skill: string]: string[];
}

/** opencode skill → bridge 专用 agent 名（agent 定义在 config/opencode.json，权限/工具收紧） */
export interface OpenCodeSkillAgents {
  [skill: string]: string;
}

export interface BridgeConfig {
  apiKey: string;
  agents: {
    pi: AgentEndpointCfg;
    "claude-code": AgentEndpointCfg;
    opencode: AgentEndpointCfg;
  };
  piSkillTools: PiSkillTools;
  claudeSkillTools: ClaudeSkillTools;
  opencodeSkillAgents: OpenCodeSkillAgents;
  bus: BusCfg;
  /** pi 网关会话模型（provider/modelId，如 amax/qwen-3.8-27B；空 = 用 settings 默认） */
  piModel: string;
  /** opencode 网关会话模型（provider/modelId；空 = 读 opencode 全局配置的 model，仍为空则用 opencode 默认） */
  opencodeModel: string;
  /** 会话空闲回收（毫秒） */
  idleMs: number;
  /** 单任务超时（毫秒） */
  taskTimeoutMs: number;
}

const DEFAULTS: BridgeConfig = {
  apiKey: "",
  agents: {
    pi: { port: 9310, defaultWorkspace: "" },
    "claude-code": { port: 9320, defaultWorkspace: "" },
    opencode: { port: 9330, defaultWorkspace: "" },
  },
  piSkillTools: {
    "code-dev": ["read", "bash", "edit", "write"],
    "repo-maintenance": ["read", "bash", "edit", "write"],
    analysis: ["read", "bash", "grep", "find", "ls"],
  },
  claudeSkillTools: {
    "code-review": [
      "Read",
      "Grep",
      "Glob",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(git status)",
      "Bash(rg *)",
    ],
    coding: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  },
  opencodeSkillAgents: {
    "code-review": "bridge-review",
    analysis: "bridge-review",
    coding: "bridge-coding",
  },
  bus: {
    bootstrapServers: ["127.0.0.1:9092"],
    taskTopic: "a2a.task",
    eventTopic: "a2a.event",
    dlqTopic: "a2a.dlq",
    partitions: 6,
    maxAttempts: 3,
  },
  piModel: "",
  opencodeModel: "",
  idleMs: 30 * 60 * 1000,
  taskTimeoutMs: 10 * 60 * 1000,
};

/** 仓库根：packages/shared/dist/config.js → 上三级 */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function loadConfig(explicitPath?: string): BridgeConfig {
  // 仓库根 .env：仅补壳里未导出的变量（已有值不覆盖）；文件不存在时跳过（本地开发可不建）
  const envFile = path.join(repoRoot(), ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const p =
    explicitPath ??
    process.env.A2A_CONFIG ??
    path.join(repoRoot(), "config", "config.json");
  let user: Partial<BridgeConfig> = {};
  try {
    user = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    if (explicitPath) throw new Error(`配置文件不存在或非法: ${p}`);
  }
  const cfg: BridgeConfig = {
    ...DEFAULTS,
    ...user,
    agents: {
      pi: { ...DEFAULTS.agents.pi, ...(user.agents?.pi ?? {}) },
      "claude-code": { ...DEFAULTS.agents["claude-code"], ...(user.agents?.["claude-code"] ?? {}) },
      opencode: { ...DEFAULTS.agents.opencode, ...(user.agents?.opencode ?? {}) },
    },
    piSkillTools: { ...DEFAULTS.piSkillTools, ...(user.piSkillTools ?? {}) },
    claudeSkillTools: { ...DEFAULTS.claudeSkillTools, ...(user.claudeSkillTools ?? {}) },
    opencodeSkillAgents: { ...DEFAULTS.opencodeSkillAgents, ...(user.opencodeSkillAgents ?? {}) },
    piModel: user.piModel ?? DEFAULTS.piModel,
    opencodeModel: user.opencodeModel ?? DEFAULTS.opencodeModel,
    bus: { ...DEFAULTS.bus, ...(user.bus ?? {}) },
  };
  if (process.env.A2A_API_KEY) cfg.apiKey = process.env.A2A_API_KEY;
  if (process.env.A2A_PI_MODEL) cfg.piModel = process.env.A2A_PI_MODEL;
  if (process.env.A2A_OC_MODEL) cfg.opencodeModel = process.env.A2A_OC_MODEL;
  if (process.env.A2A_BUS_BOOTSTRAP) {
    cfg.bus.bootstrapServers = process.env.A2A_BUS_BOOTSTRAP.split(",").map((s) => s.trim());
  }
  if (!cfg.apiKey) {
    // 本地开发允许空 key（所有请求都跑在 127.0.0.1）；对外暴露必须配置
    cfg.apiKey = "";
  }
  return cfg;
}
