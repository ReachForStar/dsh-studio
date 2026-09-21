// opencode 无头服务端原生封装：每 workspace 一个长活 `opencode serve` 进程，contextId → opencode session
// 原生实现：spawn + 裸 HTTP + SSE，不引入 @opencode-ai/sdk 包（与 cc-gateway 对 claude 的处理同思路）
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCliBin, killProcessTree } from "@a2a-bridge/shared";

export interface OcRunResult {
  ok: boolean;
  text: string;
  model?: string;
  error?: string;
}

export interface OcSession {
  sessionID: string;
  lastUsed: number;
  /** 当前在途 sendUser 的中断器（interrupt 用；空闲时 undefined） */
  inFlight?: AbortController;
  /** agent: bridge 专用 agent 名（权限/工具收紧）；model: "provider/modelId"，空 = opencode 默认 */
  sendUser(
    text: string,
    agent: string,
    model: string,
    onDelta: (delta: string) => void,
    timeoutMs: number,
  ): Promise<OcRunResult>;
  /** 远端 abort + 中断本地在途 POST（取消/超时共用） */
  interrupt(): Promise<void>;
  abort(): Promise<void>;
}

export interface OcServer {
  url: string;
  /** contextId → session */
  sessions: Map<string, OcSession>;
  getOrCreateSession(contextId: string): Promise<OcSession>;
  /** 取/建会话并发送（整体超时：超时则 abort 会话并 reject） */
  sendUserTimed(
    contextId: string,
    text: string,
    agent: string,
    model: string,
    onDelta: (d: string) => void,
    timeoutMs: number,
  ): Promise<OcRunResult>;
  releaseSession(contextId: string): void;
  kill(): void;
  lastUsed: number;
}

const SYSTEM_PROMPT =
  "你正在通过 A2A bridge 被另一个 AI agent 调用。直接执行任务，输出最终结果文本；不要输出与任务无关的寒暄。";

/** 全局 opencode 配置路径（探测自定义 provider 的 baseURL；读取顶层 model） */
function globalOpencodeConfigPath(): string {
  if (process.platform === "win32") {
    return path.join(process.env.USERPROFILE ?? os.homedir(), ".config", "opencode", "opencode.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode", "opencode.json");
}

/**
 * 会话模型来源：bridge 配置（或 A2A_OC_MODEL）优先；为空则读 opencode 全局配置的顶层 `model`——
 * 模型选择属于 opencode 自身配置，bridge 不必重复维护；两者都无则不传 model，由 opencode 自身默认决定。
 * 只读 opencode.json：opencode.jsonc 需去注释解析（不引手写 parser），需要时在 bridge 配置里显式指定。
 */
export function resolveOcModel(configured: string): string {
  if (configured) return configured;
  let raw: string;
  try {
    raw = readFileSync(globalOpencodeConfigPath(), "utf8");
  } catch {
    return ""; // 无全局配置文件：交给 opencode 自身默认（如已登录的内置 provider）
  }
  let globalCfg: { model?: unknown };
  try {
    globalCfg = JSON.parse(raw);
  } catch (e) {
    // 文件存在但非法：配置错误必须暴露，不能静默退化成“用默认模型”
    throw new Error(`opencode 全局配置解析失败: ${globalOpencodeConfigPath()}: ${e instanceof Error ? e.message : e}`);
  }
  const m = globalCfg.model;
  if (m === undefined || m === null || m === "") return "";
  if (typeof m !== "string") {
    throw new Error(`opencode 全局配置 model 应为 "provider/modelId" 字符串: ${JSON.stringify(m)}`);
  }
  return m;
}

/**
 * 自定义 provider（带 baseURL，如 amax 代理）的 /responses 端点常非标准：
 * amax 拒绝 Responses API 的历史格式（assistant 消息 content 为 output_text 项），多轮必挂。
 * 解决：配置层把该 provider 的 npm 覆盖为 @ai-sdk/openai-compatible（强制 chat completions），
 * 与全局配置深合并（apiKey/baseURL/models 原样保留，桥侧不接触密钥）。
 * 只覆盖带 baseURL 的 provider；一方 provider（openai/anthropic 等）不动，避免破坏其 responses 路径。
 */
export function buildEffectiveOcConfig(basePath: string, model: string): string {
  const provider = model ? model.split("/")[0] : "";
  if (!provider) return basePath;
  let base: Record<string, unknown>;
  try {
    base = JSON.parse(readFileSync(basePath, "utf8"));
  } catch (e) {
    throw new Error(`opencode agent 配置读取失败: ${basePath}: ${e instanceof Error ? e.message : e}`);
  }
  let globalCfg: { provider?: Record<string, { options?: { baseURL?: string } }> } | undefined;
  try {
    globalCfg = JSON.parse(readFileSync(globalOpencodeConfigPath(), "utf8"));
  } catch {
    return basePath; // 无全局配置或该 provider 不在其中：不覆盖
  }
  if (!globalCfg?.provider?.[provider]?.options?.baseURL) return basePath;
  const eff = {
    ...base,
    provider: { [provider]: { npm: "@ai-sdk/openai-compatible" } },
  };
  const dir = path.join(tmpdirA2a(), "a2a-bridge-oc");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `oc-config-${provider}.json`);
  writeFileSync(p, JSON.stringify(eff, null, 2));
  return p;
}

function tmpdirA2a(): string {
  return os.tmpdir();
}

/** "provider/modelId" → {providerID, modelID}；空串返回 undefined（用 opencode 默认模型） */
function parseModel(s: string): { providerID: string; modelID: string } | undefined {
  if (!s) return undefined;
  const i = s.indexOf("/");
  if (i <= 0) throw new Error(`opencodeModel 格式应为 provider/modelId: ${s}`);
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) };
}

async function api<T = any>(base: string, method: string, p: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  // opencode 错误体形如 {name, data:{message}}，HTTP 也可能 200（如 APIError 在 info.error 内）
  if (!res.ok || (json && json.name && json.data?.message)) {
    throw new Error(`opencode API ${method} ${p} 失败: ${res.status} ${json?.data?.message ?? text.slice(0, 200)}`);
  }
  return json as T;
}

export async function startOcServer(
  workspace: string,
  configPath: string,
  opencodeBin = "opencode",
): Promise<OcServer> {
  const resolved = resolveCliBin(opencodeBin, process.env.OPENCODE_BIN);
  // OPENCODE_CONFIG 注入 bridge 专用 agent 定义（与全局配置合并，不覆盖 provider 设置）
  const env = { ...process.env, OPENCODE_CONFIG: process.env.OPENCODE_CONFIG ?? configPath };
  const proc: ChildProcess = spawn(resolved.cmd, [...resolved.prefix, "serve", "--port", "0"], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    windowsHide: true,
  });

  let stderrBuf = "";
  proc.stderr?.on("data", (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
  });

  let url = "";
  let exitCode: number | null = null;
  proc.on("exit", (code) => (exitCode = code));

  // 等待 stdout 的 "opencode server listening on <url>"（随机端口），15s 超时
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      proc.stdout?.off("data", onData);
      killProcessTree(proc);
      reject(new Error(`opencode serve 启动超时: ${stderrBuf.slice(-500) || "无输出"}`));
    }, 15_000);
    const onData = (d: Buffer) => {
      const m = d.toString().match(/listening on (https?:\/\/[^\s]+)/);
      if (m) {
        url = m[1];
        clearTimeout(t);
        proc.stdout?.off("data", onData);
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.on("error", (e) => {
      clearTimeout(t);
      proc.stdout?.off("data", onData);
      reject(new Error(`opencode 启动失败: ${e.message}（可用 OPENCODE_BIN 环境变量指定可执行文件）`));
    });
  });

  // 健康检查就绪
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const h = await api<{ healthy?: boolean }>(url, "GET", "/global/health");
      if (h.healthy) break;
    } catch {
      /* 未就绪 */
    }
    if (Date.now() > deadline || exitCode !== null) {
      killProcessTree(proc);
      throw new Error(`opencode serve 健康检查失败: ${stderrBuf.slice(-300)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // 全服 SSE 事件流：按 sessionID 路由给当前 in-flight 的 sendUser（断线 2s 重连；丢帧无碍，POST 响应兜底）
  const handlers = new Map<string, ((ev: any) => void) | undefined>();
  let sseStopped = false;
  (async () => {
    while (!sseStopped) {
      try {
        const res = await fetch(`${url}/event`, { headers: { accept: "text/event-stream" } });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        let buf = "";
        for await (const chunk of res.body) {
          if (sseStopped) break;
          buf += chunk.toString();
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const ev = JSON.parse(line.slice(6));
                const h = handlers.get(ev.properties?.sessionID ?? "");
                if (h) h(ev);
              } catch {
                /* 非 JSON 帧忽略 */
              }
            }
          }
        }
      } catch {
        /* 断线重连 */
      }
      if (!sseStopped) await new Promise((r) => setTimeout(r, 2000));
    }
  })();

  let modelLogged = false;

  const server: OcServer = {
    url,
    sessions: new Map(),
    lastUsed: Date.now(),
    async getOrCreateSession(contextId: string) {
      const existing = this.sessions.get(contextId);
      if (existing) return existing;
      const s = await api<{ id: string }>(url, "POST", "/session", {
        title: `a2a-${contextId.slice(0, 12)}`,
      });
      const session: OcSession = {
        sessionID: s.id,
        lastUsed: Date.now(),
        async sendUser(text, agent, model, onDelta, timeoutMs) {
          session.lastUsed = Date.now();
          server.lastUsed = Date.now();
          // 前缀增量：opencode 的 message.part.updated 携带 part 全量文本（无 delta 事件），按 part 记录已发前缀自算增量
          const emitted = new Map<string, string>();
          const streamedAny = { v: false };
          const handler = (ev: any) => {
            if (ev.type !== "message.part.updated") return;
            const part = ev.properties?.part;
            if (!part || part.type !== "text" || typeof part.text !== "string") return;
            const key = `${part.messageID}:${part.id}`;
            const prev = emitted.get(key) ?? "";
            if (part.text.startsWith(prev)) {
              const delta = part.text.slice(prev.length);
              if (delta) {
                emitted.set(key, part.text);
                streamedAny.v = true;
                onDelta(delta);
              }
            } else {
              // 文本被重置（非前缀扩展），全量重发
              emitted.set(key, part.text);
              streamedAny.v = true;
              onDelta(part.text);
            }
          };
          handlers.set(session.sessionID, handler);
          // 在途 POST 的本地中断：interrupt() 切断 in-flight fetch 并唤醒退避等待，取消/超时不依赖响应返回
          const inFlight = new AbortController();
          session.inFlight = inFlight;
          try {
            // 供应商端点（如 amax）间歇性校验错误：opencode 内置重试有时不够，bridge 层再重试 2 次（退避 2s/4s）
            const maxTries = 3;
            let lastErr: string | undefined;
            let info: any;
            let parts: any[] = [];
            for (let i = 0; i < maxTries; i++) {
              try {
                const body: Record<string, unknown> = {
                  parts: [{ type: "text", text }],
                  agent,
                  system: SYSTEM_PROMPT,
                };
                const m = parseModel(model);
                if (m) body.model = m;
                const r = await api(url, "POST", `/session/${session.sessionID}/message`, body, inFlight.signal);
                info = r?.info;
                parts = r?.parts ?? [];
                if (info?.error) {
                  lastErr = info.error.message ?? info.error.name ?? "unknown";
                } else {
                  lastErr = undefined;
                  break;
                }
              } catch (e) {
                // interrupt 触发：立即结束重试循环，避免取消后继续重投
                if (inFlight.signal.aborted) {
                  lastErr = "已取消";
                  break;
                }
                lastErr = e instanceof Error ? e.message : String(e);
              }
              if (i < maxTries - 1) {
                await new Promise<void>((r) => {
                  const t = setTimeout(r, 2000 * (i + 1));
                  inFlight.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
                });
                if (inFlight.signal.aborted) break;
              }
            }
            if (lastErr) return { ok: false, text: "", error: lastErr };
            if (info?.modelID && !modelLogged) {
              modelLogged = true;
              console.error(`[opencode] 会话模型: ${info.providerID}/${info.modelID}`);
            }
            // 兜底：SSE 无增量（纯工具调用或 SSE 断流）时从响应 parts 取最终文本
            const fullText = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
            if (!streamedAny.v && fullText) onDelta(fullText);
            return {
              ok: true,
              text: fullText,
              model: info?.modelID ? `${info.providerID}/${info.modelID}` : undefined,
            };
          } finally {
            handlers.delete(session.sessionID);
          }
        },
        async interrupt() {
          session.inFlight?.abort();
          await session.abort();
        },
        async abort() {
          try {
            await api(url, "POST", `/session/${session.sessionID}/abort`);
          } catch {
            /* 会话可能已空闲 */
          }
        },
      };
      this.sessions.set(contextId, session);
      return session;
    },
    releaseSession(contextId: string) {
      this.sessions.delete(contextId);
    },
    async sendUserTimed(contextId, text, agent, model, onDelta, timeoutMs) {
      const sess = await this.getOrCreateSession(contextId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          void sess.interrupt();
          rej(new Error(`opencode 执行超时 (${timeoutMs}ms)`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([sess.sendUser(text, agent, model, onDelta, timeoutMs), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    kill() {
      sseStopped = true;
      killProcessTree(proc);
    },
  };

  return server;
}
