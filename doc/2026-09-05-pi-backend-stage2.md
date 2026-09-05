# 2026-09-05 pi 后端接入（阶段 2 POC）：pi-agent-loop

## 任务目标

把 pi 的 coding-agent 运行时挂成 dsh 的第二个 agent 后端（`meta.backend: 'pi'`），先跑通「dsh 会话由 pi 用自己的模型与工具驱动」的最小闭环，共享工具/模型留到阶段 4，事件对齐留到阶段 3。

## 干了什么

新增 `packages/core/pi-agent-loop`（`@deepseek-ai/dsh-pi-agent-loop`）：

- `src/agent.ts` — `PiLoopAgent implements Agent`，实现 dsh 的 Agent seam：
  - `followup` → pi `prompt`；`steer` → pi `steer`；`send` 按 target 分发。
  - `cancel` → pi `abort`；`whenIdle`/`status` 用「活跃计数 + pi.isStreaming」推导。
  - `inject` 为 no-op（pi 无跨请求上下文注入 seam）；`runMaintenance` 直接跑。
  - 保留 dsh `session`/`inbox`（inbox 空转），pi 的 `AgentSession` 才是执行引擎。
- `src/pi-session.ts` — 封装 pi SDK：`createAgentSessionServices({cwd})` + `SessionManager.inMemory` + `createAgentSessionFromServices`，隔离可注入。
- `src/index.ts` — `PiLoop extends Service implements AgentFactory`，`static inject = ['agents','sessions']`，用 `setFactory(this,'pi')` 注册；`createAgent` 走 `sessions.prepare` + pi session + 发布（enter/announce + `agent/session-start`）；`resume` 暂为 fresh pi session（未回放历史）。
- `tests/agent.spec.ts` — 4 个用例（mock pi session）：followup/steer 桥接、running/idle 状态、`meta.backend:'pi'` 创建路由、resume 路由。

仓库级注册：`tsconfig.base.json` paths、`tsconfig.host.json` reference、`pnpm-lock.yaml`（pi-coding-agent ^0.84.4）。

## 验证结果
- `vitest run packages/core/pi-agent-loop`：4 tests 通过。
- `oxlint` 通过；`tsc -b packages/core/pi-agent-loop` 通过；pre-push 全量 typecheck 通过。
- **真实 e2e 跑通**（`pi-session.e2e.ts`）：用 `.env` 的 AMAX 网关（`qwen-3.8-27B` @ `ai.amaxsmp.com/v1`）真实驱动 pi 跑完 `bash ls` 任务，断言输出含标记文件。

## 改了什么（相对历史）
- 提交 `a5a587bea2`，11 files changed，+557/-11，推送到 fork master。

## 已知问题与风险
- **事件未回写 dsh session log**：pi 的 turn/step/消息不进入 `SessionEventMap`，因此 dsh 的 subagent/plan/projection/UI 读不到 pi 会话内容（阶段 3 做事件对齐）。
- **resume 不回放 pi 历史**：`resume` 重建一个空 pi 会话；pi 消息树未持久化/恢复。
- **模型与工具未共享**：pi 用 `pi-coding-agent` 自己的 `ModelRuntime`（读 agentDir auth）和默认工具，尚未桥到 dsh 的 `ctx.llm`/`ctx.tools`（阶段 4）。
- `runMaintenance`/`inject` 是近似语义，后续对齐。
- e2e 网关配置用 `AMAX_API_KEY`/`AMAX_MODEL`/`AMAX_BASE_URL`（避开 vite 内置 `BASE_URL` 冲突）。

## 后续演进方向
- 阶段 3：pi `AgentEvent` → dsh `SessionEventMap` 事件对齐，使 pi 会话进入 dsh 的 subagent/plan/projection。
- 阶段 4：共享模型（桥到 `ctx.llm`）与工具（dsh 工具暴露给 pi、pi 工具注册进 `ctx.tools`）。