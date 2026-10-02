---
title: 星域预设不可见与普通消息没有回复（2026-10-02）
type: query
tags: [星域, preset, 界面, pi-ai, 模型请求, 故障排查]
created: 2026-10-02
updated: 2026-10-02
sources: []
status: active
---

# 星域预设不可见与普通消息没有回复（2026-10-02）

## 问题

用户反馈星域无法启用或显示任务，进一步明确为选择「启明 · 星域路由」后发送普通消息没有反应。本次排查覆盖预设入口、父代理模型请求与专家席派发。

## 根因与已核实证据

### 预设入口隐藏

`ui-agent-preset` 原先按 `a2aStatus.available` 隐藏 `xingchen-qiming`，预设显示、预设管理与会话预设三个入口均查询并等待 A2A 状态。该字段实际等于入站 `a2a-host` 的 `hostRunning`，只能说明本部署有没有监听入站请求；星域的 `local` 席位经 `ctx.subagents` 运行，无需入站 A2A Host。该筛选条件会把支持本地运行的启明预设隐藏。

源码已删除这项筛选和三个入口的 A2A 状态查询。选择器按 Host roster 的 `broken` 排除故障预设，管理页保留已声明的预设供诊断；相关客户端测试已通过。

### 普通消息在模型请求阶段失败

真实会话 `6c49b82f-e7c3-4743-be6b-91b98288f39a` 与 `0172c991-f9a7-4008-99f7-20ce9ff288b6` 都记录了选择 `xingchen-qiming`，随后存在 `turn/start`、`step/start`、`system/message`、`user/message`、`request/header`，最终以 `assistant/attempt` 和 `turn/end(error)` 结束。两条会话的路由均为 `amax/c-y2/gpt-6-sol`，各出现三次零用量失败；错误码为 `PI_AI_ERROR`，信息为 `Eligible upstream attempts could not produce a valid response`，日志没有 `tool/call`。

这些记录说明普通消息已经进入父代理模型请求，失败发生在专家派发之前。同日 `standard` 预设在相同路由也失败，改用 `amax/deepseek-flash` 后完成多轮，因此这些会话不能证明星域的专家派发失败。`amax/c-y2/gpt-6-sol` 的失败属于该上游路由返回无有效响应，未发现星域派发代码证据。

排查时用户 Web profile 的 `agent-default-model` 已是 `amax/deepseek-flash`；此前失败会话仍记录旧路由，需要分别核对现有会话的模型选择与新会话默认值，不能把全局默认值重复改动当成现有会话已恢复的证据。

### 最小真实模型验证

通过真实 Cordis Context、`LlmRuntime`、`LocalCredentialProvider` 与 `llm-pi-ai` 读取用户配置，以 `amax/deepseek-flash` 发送「只回复 OK」后收到文本 `OK`，`finish.reason.kind` 为 `stop`。该次请求耗时 `1075ms`，输入 `33` token、输出 `12` token；验证使用真实模型响应，确认该路由在排查时可用。现有失败会话仍保留旧的模型选择，不能由全局默认值自动切换。

### 随包配置与当前派发方式

启明预设位于 `packages/bundle/web-app/presets/xingchen-qiming.patch.yml`，旧 `packages/preset/agent-presets/presets/` 目录已不存在。随包基础组合的 `a2a` 行没有 `peers` 或 `bridge`，启明预设没有指定席位模式。

`XingchenService` 在挂载时检查 `ctx.a2a.list()`，角色绑定的对等端存在时默认 `a2a`，否则为 `local`；显式 `seats.<role>.mode` 优先。普通消息先由启明运行模型轮次，只有 `xingchen_route` 工具与 `/review`、`/bug`、`/planning` 命令才派发专家任务，`routeXingchen` 分类器不会自行派发。

## 解法与待验证项

- 已完成：取消用入站 A2A Host 状态隐藏启明预设，删除无使用的 `ui-a2a-status` 依赖与项目引用；相关客户端测试通过。
- 已完成：真实运行时使用用户配置请求 `amax/deepseek-flash`，最小请求返回 `OK` 并以 `stop` 正常结束。
- 已确认：现有失败会话把 `amax/c-y2/gpt-6-sol` 写入各自的请求头；全局默认值不会改写既有会话。失败发生在模型请求阶段，没有 `tool/call`，因此不属于星域专家派发故障。
- 待补充：当前 Web 实例未运行，无法通过正式 Remote 接口把旧会话改为 `amax/deepseek-flash`；不修改用户会话文件，也不把最小模型请求冒充完整会话恢复。

## 已验证的连带修复

同批排查还修掉两处与星域可用性相邻的缺陷：

- **HTTP 桥接的监听器泄漏**（`packages/client/connection/src/http-bridge.ts`）：压缩中间件把 `res.on('drain')` 转发到内部 gzip 流，但不转发 `res.off`，`once('drain')` 的自动移除因此失效，每个背压事件泄漏一个监听器。改为一个贯穿响应生命周期的 `on('drain')` 配合 `pendingDrain` 回调。
- **画布导出与工具卡自动跳转**（`packages/client/ui-polish`）：导出前校验 Excalidraw API 是否就绪，并补 `excalidraw.exporting` 与 `excalidraw.canvasNotReady` 两条文案；删除工具结果到达时自动切换到画布标签页的副作用，切标签页改为只由用户点击触发。

## 验证

- `pnpm exec vitest run packages/client/ui-agent-preset/tests`：6 个文件 130 项通过，含新增的「无 A2A Host 状态时仍提供 xingchen-qiming」回归用例。
- `pnpm exec vitest run packages/client/connection/tests/http-bridge.host.spec.ts packages/client/ui-polish/tests/apply.client.spec.ts`：断开处理、监听器数量与画布标签页接线全部通过。
- `pnpm run typecheck`：宿主面构建与客户端面类型检查均通过（`typecheck:contracts-ready` 退出码 0）。
- `pnpm run verify-cordis-config`：除本机符号链接项外无其他报错，说明新增的 `tool-excalidraw` 预设行能解析。
- `node tmp/probe-xingchen-model.mjs`：真实 `amax/deepseek-flash` 请求返回 `OK`，结束原因为 `stop`。

## 涉及模块

- [星域多智能体](../entities/xingchen-multi-agent.md)：角色、席位运行方式、工具与命令派发。
- [llm-pi-ai](../entities/llm-pi-ai.md)：父代理模型请求与上游错误。
- [`ui-agent-preset`](../../../packages/client/ui-agent-preset/README.zh.md)：预设选择器与管理页。
- [`ui-a2a-status` 状态存储](../../../packages/client/ui-a2a-status/src/client/a2a-status-store.ts)：入站 Host 状态字段的客户端来源。

## 复发预防

预设可用性以宿主的预设解析与挂载结果为依据。入站 A2A Host、出站对等端和本地子代理具有不同的配置前置，界面不能用单一监听状态替代这些条件。普通消息没有专家任务时，先核对会话是否已经进入模型请求，以及有没有 `tool/call` 或专家命令记录，再定位派发故障。更换全局模型默认值后，已有会话仍使用自身记录的选择；要让旧会话改用新模型，必须经 `session/selectModel` 写入 `model/selection`，全局默认值只影响此后新建的会话。
