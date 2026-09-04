# 2026-09-05 pi 后端接入（阶段 1）：会话按 backend 路由

## 任务目标

把 pi 作为 deepseek-harness 的一个头等执行后端（非 subagent），目标形态：每个会话可选后端、共享工具/模型。本阶段只做第一步——**会话后端的路由机制**，入口是 `CreateAgentOptions.meta.backend`。

## 干了什么

### 类型与持久化
- `packages/core/session/src/types.ts`：新增 `AgentBackend = 'dsh' | 'pi'`；`SessionHeader` 与 `CreateSessionOptions.meta` 增加可选 `backend` 字段（缺省 = `dsh`）。
- `packages/core/session/src/index.ts`：`validateSessionHeader` 校验 `backend ∈ {dsh, pi}`（缺省放行，向后兼容旧 v2 会话）；`prepare` 把 `meta.backend` fold 进 header。
- `packages/session/session-persistence-jsonl/src/format.ts`：`HeaderLine`/`toHeaderLine`/`fromHeaderLine`/`isHeaderLine` 全链路支持 `backend` 字段的写入、回读、校验，保证 JSONL 往返不丢字段。

### 路由
- `packages/core/agent/src/index.ts`：
  - `SetFactory` 从单例改为 `Map<AgentBackend, FactorySlot>`，`setFactory(factory, backend = 'dsh')`。
  - `create` 经 `options.meta?.backend ?? 'dsh'` 路由；`resume` 经 `options.backend ?? 'dsh'` 路由。
  - 未注册 backend 时报错（默认 backend 保持原 `/no agent factory/` 文案，向后兼容既有测试）。

### 测试
- `agent.spec.ts` 新增 3 个用例：跨 backend 路由、同 backend 重复注册拒绝、缺 factory 报错。
- `jsonl.spec.ts` 的 header 往返用例补 `backend: 'pi'`，验证持久化往返。

## 验证结果
- `vitest run core/agent core/session`：41 files / 743 tests 通过。
- `vitest run session-persistence-jsonl session-format session-log-deepseek`：22 files / 583 tests 通过。
- `oxlint` 通过；pre-push 全量 `tsc -b tsconfig.client.json` typecheck 通过。

## 改了什么（相对历史）
- 提交 `b5a203a11a`，6 files changed, +92/-13，已推送到 fork master。

## 已知问题与风险
- `ResumeAgentOptions.backend` 目前是显式参数，尚未改为「自动从持久化 header 读回」——需要阶段 2（真挂 pi factory）时，让 resume 上层（ACP/session-controller/subagent）从 header 填 backend，或引入 resolver。
- `SESSION_FORMAT_VERSION` 未 bump：`backend` 是缺省即 `dsh` 的可选元数据，语义向后兼容；真正引入 pi 后端若改变日志语义，需重新评估。
- session-log-deepseek 的上传 wire header 未带 backend（DeepSeek 官方 schema 不动）；本地 resume 不依赖它。

## 后续演进方向
- 阶段 2：实现 `pi-agent-loop`（`PiLoopAgent implements Agent`），把 pi `AgentSessionRuntime` 桥成 `AgentFactory`，同时把 pi 的 `ModelRuntime`/工具桥到 `ctx.llm`/`ctx.tools`。
- 阶段 3：pi `AgentEvent` → dsh `SessionEventMap` 事件对齐，使 pi 会话可被 subagent/plan/projection/UI 消费。
- 阶段 4：工具双向互补。