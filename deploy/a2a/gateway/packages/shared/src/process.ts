// 子进程工具：Windows CLI shim 解析与进程树终止（cc-gateway / oc-gateway 共用）
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ResolvedBin {
  cmd: string;
  prefix: string[];
}

/**
 * 解析 CLI 可执行入口。Windows 下 `where.exe` 的首行常是 npm 生成的**无扩展名 sh 脚本**，
 * 只有第二行才是 `.cmd`：直接 spawn 落到 `cmd /d /c <bin>` 包装层，而 TerminateProcess
 * 杀不掉包装层的孙子进程——CLI 本体成孤儿继续占端口。故优先选 `.exe`（直跑）或 `.cmd` 行
 * 并解析出真实 .exe/.js 入口；实在没有可用行才退回 cmd 包装。
 */
export function resolveCliBin(bin: string, envBin?: string): ResolvedBin {
  if (envBin) return { cmd: envBin, prefix: [] };
  if (process.platform !== "win32") return { cmd: bin, prefix: [] };
  try {
    const r = spawnSync("where.exe", [bin], { encoding: "utf8" });
    const lines = (r.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (line.toLowerCase().endsWith(".exe") && existsSync(line)) return { cmd: line, prefix: [] };
    }
    for (const line of lines) {
      if (!line.toLowerCase().endsWith(".cmd")) continue;
      const m = readFileSync(line, "utf8").match(/%dp0%\\?\"?([^\"%\s]+)/i);
      if (!m) continue;
      const target = path.join(path.dirname(line), m[1].replace(/\\/g, path.sep));
      if (!existsSync(target)) continue;
      if (target.toLowerCase().endsWith(".exe")) return { cmd: target, prefix: [] };
      if (target.toLowerCase().endsWith(".js")) return { cmd: process.execPath, prefix: [target] };
    }
  } catch {
    /* 解析失败走兜底 */
  }
  const com = process.env.ComSpec ?? "cmd.exe";
  return { cmd: com, prefix: ["/d", "/c", bin] };
}

/** 终止子进程及其整棵进程树：Windows 的 TerminateProcess 不杀子进程（spawn 经包装层时子进程成孤儿） */
export function killProcessTree(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.pid === undefined) return;
  if (process.platform !== "win32") {
    proc.kill();
    return;
  }
  const r = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  if (r.error) proc.kill(); // taskkill 不可用时退回直接终止
}
