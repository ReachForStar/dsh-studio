# 2026-09-05 pi 后端接入（阶段 4）：共享模型与 dsh 工具适配

## 任务目标

让 pi 会话复用 dsh 的模型路由与工具后端，实现「同一 harness 里互补」的最后一块。

## 干了什么

- **模型共享**：`openPiSession` 接受 `provider`/`modelId`，用 pi `ModelRuntime.getModel` 选模型；`PiLoop.createAgent` 把 dsh `agentOptions.provider/model` 透传给 pi 会话。
- **dsh → pi 工具适配**：新增 `src/dsh-tool-adapter.ts` 的 `adaptDshTool`，把 dsh 工具包装成 pi 自定义工具：
  - `execute` 桥接到 dsh `ToolRuntime.execute`（`callId/name/arguments/agent/signal`），结果 `content` 返回给 pi。
  - 参数 schema 用空 pass-through（dsh 在 `ToolRuntime.execute` 内做真正的 schema 校验）；JSON Schema → TypeBox 的精确镜像留作后续。
- `PiEventTranslator`、`adaptDshTool` 已从包入口导出；`tsconfig.json` 补 `core/tools` reference。

## 验证结果

- `dsh-tool-adapter.spec.ts`：mock `ToolRuntime.execute`，验证适配后的 pi 工具按其 name/arguments 桥接并回传 content。通过。
- 全量 `pi-agent-loop` mock 测试 7 通过；`oxlint`、`tsc -b`、pre-push 全量 typecheck 通过。

## 改了什么（相对历史）

- 提交 `f8efba7b7a`，6 files changed，+151/−3，推送到 fork master。

## 已知问题与风险

- **工具 schema 未镜像**：pi 侧工具参数是空 schema（`parameters: {}`），模型拿不到 dsh 工具的 JSON Schema 描述，调用质量打折扣。精确的 JSON Schema → TypeBox 转换是后续主要工作。
- **未在 PiLoop 完整链路挂接 customTools**：`adaptDshTool` 是独立可测的适配函数；把它接到 `openPiSession` 的 `customTools`（需要解 agent 生命周期：pi 会话先建、PiLoopAgent 后建）留待收口。
- **pi → dsh 方向未做**：pi 自带工具（read/write/edit/bash + extensions）尚未注册进 dsh `ctx.tools`——dsh 本身已有对等工具，收益低，未纳入本阶段。

## 后续演进方向

- 完成 JSON Schema → TypeBox 的精确转换，给 pi 工具完整参数描述。
- 把 `adaptDshTool` 接到 PiLoop 的会话创建（解 agent 生命周期）。
- 若需要 pi 工具进 dsh，再做 pi → dsh 方向。