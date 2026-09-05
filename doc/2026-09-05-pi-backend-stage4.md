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

- 双向工具适配的 schema 镜像覆盖常见形状（object/string/number/integer/boolean/array/enum/const/oneOf）；更复杂的 TypeBox 联合/修饰符随需补。

---

## 补齐（提交 `3f0ab53916`、`17cff57c89`）

- **工具 schema 镜像**：`dshSchemaToTypeBox` 把 dsh 参数声明镜像成 TypeBox schema。
- **customTools 挂接（dsh→pi）**：`PiLoopAgent.registerDshTools` 借 `extensionRunner.registerTool` 把 dsh 工具动态注册进 pi 会话。
- **pi→dsh 工具共享**：`adaptPiTool` 把 pi 工具（扩展/skills）适配成 dsh 工具，`PiLoopAgent.registerPiTools` 借 `extensionRunner.getAllRegisteredTools` 把 pi 工具注册进 `ctx.tools`，TypeBox 参数镜像成 dsh schema。
- 新增 schema 镜像 + 双向适配单测；全量 mock 测试 10 通过；oxlint + 全量 typecheck 通过。
## 补齐（提交 `6d92c34c3b`）

- **schema 镜像扩展**：dsh `type: 'json'` → TypeBox `Type.Any`；`null` → `Type.Null`；`description`/`title`/`default` 注解双向保留；TypeBox `Type.Any`/`Type.Unknown`（无 type）回映射 dsh `type: 'json'`。
- 新增 json/null/注解镜像单测；全量 mock 测试 12 通过；oxlint + 全量 typecheck 通过。
