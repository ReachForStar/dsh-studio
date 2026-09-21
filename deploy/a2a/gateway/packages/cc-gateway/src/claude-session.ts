// Claude Code 无头会话：每 contextId 一个长活 `claude -p` 双向 stream-json 子进程
import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree, resolveCliBin } from "@a2a-bridge/shared";

export interface ClaudeRunResult {
  ok: boolean;
  resultText: string;
  isError: boolean;
  sessionId?: string;
  numTurns?: number;
}

export interface ClaudeSession {
  sessionId?: string;
  sendUser(text: string, onDelta: (delta: string) => void, timeoutMs: number): Promise<ClaudeRunResult>;
  lastUsed: number;
  kill(): void;
}

const SYSTEM_PROMPT =
  "你正在通过 A2A bridge 被另一个 AI agent 调用。直接执行任务，输出最终结果文本；不要输出与任务无关的寒暄。";

export function spawnClaudeSession(
  workspace: string,
  allowedTools: string[],
  claudeBin = "claude",
): ClaudeSession {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt", SYSTEM_PROMPT,
  ];
  if (allowedTools.length > 0) args.push("--allowedTools", ...allowedTools);
  const resolved = resolveCliBin(claudeBin, process.env.CLAUDE_BIN);

  const proc: ChildProcess = spawn(resolved.cmd, [...resolved.prefix, ...args], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
  });

  let spawnErr: Error | undefined;
  proc.on("error", (e) => {
    spawnErr = e;
    // 唤醒可能悬挂的 sendUser
    session.sessionId = undefined;
    try {
      proc.stdin?.end();
    } catch {
      /* 忽略 */
    }
  });

  let stderrBuf = "";
  proc.stderr?.on("data", (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
  });

  let exitCode: number | null = null;
  proc.on("exit", (code) => (exitCode = code));

  // stdout 逐行 JSON 事件
  let lineBuf = "";
  let onEvent: ((line: string) => void) | null = null;
  let modelLogged = false;
  proc.stdout?.on("data", (d: Buffer) => {
    lineBuf += d.toString();
    let idx: number;
    while ((idx = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (line && onEvent) onEvent(line);
    }
  });

  const session: ClaudeSession = {
    sessionId: undefined,
    lastUsed: Date.now(),

    sendUser(text, onDelta, timeoutMs) {
      return new Promise<ClaudeRunResult>((resolve, reject) => {
        if (exitCode !== null) {
          reject(new Error(`claude 进程已退出 (code=${exitCode}): ${stderrBuf.slice(-500)}`));
          return;
        }
        if (spawnErr) {
          reject(new Error(`claude 启动失败: ${spawnErr.message}（可用 CLAUDE_BIN 环境变量指定可执行文件）`));
          return;
        }
        session.lastUsed = Date.now();
        let done = false;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            onEvent = null;
            reject(new Error(`claude 执行超时 (${timeoutMs}ms)`));
          }
        }, timeoutMs);

        onEvent = (line) => {
          let ev: Record<string, any>;
          try {
            ev = JSON.parse(line);
          } catch {
            return; // 非 JSON 行（hook 噪音等）忽略
          }
          if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
            session.sessionId = ev.session_id;
          } else if (ev.type === "assistant" && ev.message?.model && !modelLogged) {
            // 首个 assistant 事件带模型名：确认会话实际使用的模型（CC 侧模型跟随 claude 自身配置）
            modelLogged = true;
            console.error(`[claude] 会话模型: ${ev.message.model}`);
          } else if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") {
            const delta: string = ev.event.delta.text ?? "";
            if (delta) onDelta(delta);
          } else if (ev.type === "result") {
            if (done) return;
            done = true;
            clearTimeout(timer);
            onEvent = null;
            const isError = Boolean(ev.is_error);
            const resultText = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result ?? "");
            if (isError || !resultText) {
              // 空结果（如全被权限拒绝）视为失败，便于上游重试/告警
              resolve({
                ok: !isError,
                resultText: resultText || stderrBuf.slice(-1000) || "claude 未返回结果",
                isError,
                sessionId: session.sessionId,
                numTurns: ev.num_turns,
              });
            } else {
              resolve({ ok: true, resultText, isError, sessionId: session.sessionId, numTurns: ev.num_turns });
            }
          }
        };

        const payload = JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
        });
        try {
          proc.stdin?.write(payload + "\n");
        } catch (e) {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },

    kill() {
      try {
        proc.stdin?.end();
      } catch {
        /* 忽略 */
      }
      killProcessTree(proc);
    },
  };

  return session;
}
