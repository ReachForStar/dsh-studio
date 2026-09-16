---
title: pi 后端（pi-agent-loop）
type: entity
tags: [pi, agent-loop, backend, session, amax]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: active
---

# pi 后端（pi-agent-loop）

## 职责

把 Pi coding-agent 运行时当成 dsh 的第二个会话后端：dsh 拥有会话日志、头部元数据、工具策略与持久化，Pi 拥有回合循环（模型会话、流式输出、工具调用）。会话头部记录 `backend: 'pi'`，resume 据此回到同一循环。

## 关键文件与接口

| 位置 | 作用 |
| --- | --- |
| `packages/core/pi-agent-loop/src/index.ts` | `PiLoop`（Service + `AgentFactory`）：`createAgent`/`resume`/`launch`/`publish`，向 `ctx.agents.setFactory(this, 'pi')` 注册 |
| `packages/core/pi-agent-loop/src/agent.ts` | `PiLoopAgent`：会话准备、事件发布、durable 写入句柄 |
| `packages/core/pi-agent-loop/src/pi-session.ts`、`pi-event-translator.ts` | Pi 会话与事件 → dsh 会话事件的映射 |
| `packages/core/pi-agent-loop/src/dsh-tool-adapter.ts` | dsh 工具 → Pi custom tool（TypeBox 参数镜像；dsh 内仍重新校验） |
| `packages/core/pi-agent-loop/src/pi-tool-adapter.ts` | Pi 注册工具 → dsh 工具面 |
| `packages/subagent/subagent-pi/` | 子代理形态的 pi provider（独立进程） |
| `packages/llm/llm-pi-ai/` | pi-ai 适配器与 AMAX Token Router 网关（`AMAX_PROVIDER`，`AMAX_API_KEY`） |

配置：`model: { provider, modelId }` 与 `providers: PiProviderConfig[]`（OpenAI 兼容网关）；`packages/core/pi-agent-loop/README.md` 拥有完整字段表。

## 上下游依赖

- 上游：`ctx.agents`（`setFactory`/`enter`/`announce`）、`ctx.sessions.prepare`、`sessionPersistence`（`create`/`open`）、`ctx.tools`（`ToolRuntime.execute`）、`ctx.llm`。
- 下游：Web/CLI 会话由 `backend` 选择循环；`subagent-pi` 复用同一 Pi 运行时做子进程隔离。

## 合并上游后的 API 适配（2026-09）

| 上游变更 | fork 侧适配 |
| --- | --- |
| `AgentFactory.create/resume(ownerCtx, options)` 语义变化 | 统一走 `launch(options, 'startup' \| 'resume', durableFactory?)`，`publish(agent, opened, setup, durable?, source)` |
| `AgentSetup` 变为 `(ctx, agent)` 两参 | `setup?.(agent.ctx, agent)` |
| `agents.enter`/`agents.announce` 取代手工 `agent/session-start` | `agents.enter(agent, undefined)`（root owner）+ `await this.ctx.agents.announce(agent, source)`；删除自定义 `agent/session-start` 发布 |
| `Inbox` 由类变为接口（pi 驱动时不接管） | `PiLoopAgent` 注入惰性 `Inbox` 字面量（`nextTurn`/`nextStep` 为空，写操作空实现） |
| `SubprocessHandle` 去掉 `pid`，新增 `waitForExit(signal?)` | `subagent-pi` 用 `rangeExitsWithin(child, ms)`（AbortController + `waitForExit(signal)`）替代 pid 探测；`done` 在启动失败时 reject，`waitForExit` 仍 resolve |

## 重要变更记录

- 2026-09：合并上游 `upstream/master`，完成上表全部适配；`typecheck`/`build` 通过，e2e 在无 `AMAX_API_KEY` 时自跳过。
- 已知限制见 `packages/core/pi-agent-loop/README.md` 的「Known Limitations and Deferred Work」：inbox 不接管、无 `agent/session-start`、Pi 专有工具特性不做近似、模型路线需显式声明、resume 依赖持久化。
