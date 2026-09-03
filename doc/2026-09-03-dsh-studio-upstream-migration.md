# dsh-studio fork 合并 upstream 与客户端栈迁移（进行中）

日期：2026-09-03
分支：master（fork，本地 remote: fork=ReachForStar/dsh-studio, upstream=deepseek-ai/deepseek-harness）
性质：本文件是**迁移过程文档**，最新一篇即当前项目状态；跨会话续接请先读本文件与 `.agents/notes/implemented/architecture/` 下相关决策。

## 任务目标

1. 把 fork（dsh-studio）合并到 latest upstream（deepseek-harness），以 upstream 当前架构为基准；upstream 废弃模块在 fork 一并废除，保留 fork 产品改动。
2. fork 自研包改名为 `@reachforstar` scope（保留 `dsh-` 前缀）。
3. 把 fork 旧客户端框架迁移到 upstream 新客户端框架（方案 B：彻底迁移，逐面板推进；用户否决了保留自研栈的 B1）。

## 已完成（均提交于 master，未 push，typecheck 未全绿前不 push）

- `03df8d2` 合并提交（--no-verify，用户批准）：resolve 72 个冲突；删除 upstream 移除的模块（apiproxy、examples/、knip.json、旧 client 测试等）；保留 fork 7 个精简 CI workflow；恢复 fork 自研 `packages/client/runtime`（去掉对已删 apiproxy 的依赖，改连 `@deepseek-ai/dsh-client-connection`）。
- `cfc27101a6` host（服务端）类型修复至 0 错误：JsonValue 改自 dsh-util-values、settingsNamespace() → 字符串字面量、installSettingsSection → ctx.settings.installSection、CallId → ToolCallId 等。
- `3413ee0ed0` client 侧机械修复（slot-catalog 语法、SESSION_SEARCH_RESULT_LIMIT、ToolCallId）。
- 工作区清理（无提交）：删除 7 个无 package.json 的目录残留壳后，tsdown build:lib:host 通过、typert `/remote` 类型可生成。
- 9 个自研包改名 `@reachforstar/*`：dsh-ssh、dsh-ssh-local、dsh-tool-ssh、dsh-host-ssh-remotes、dsh-subagent-pi、dsh-tool-excalidraw、dsh-client-ui-polish、dsh-client-ui-ssh、dsh-client-runtime（全仓 sed + tsconfig.base 手写别名 + pnpm-lock）。
- `31fc93e0ff`~`e061f9895a` **ui-ssh（SSH 面板）整体迁移完成**：
  - `ClientContext`（fork runtime）→ cordis `Context`；`ctx.remote.ssh` 通过 ssh-remotes 生成的 typert `/remote` 类型并入 `ClientRemote`（tsconfig.base 加 `@reachforstar/dsh-host-ssh-remotes/remote` → `packages/host/ssh-remotes/lib/typert.remote-client.d.ts` 别名）。
  - SshRemote 载荷类型别名指向 lib 产物（`.../types` → `lib/types/types.d.ts`），避免 client↔host src 项目边界 TS6059/TS2878；ui-ssh 不再引用 host 项目。
  - store 从 fork `createSnapshotStore/SnapshotStore` → `@deepseek-ai/dsh-client-store`（签名兼容：init + `.update(draft)`）。
  - `ctx.slots` 增广来自 `@deepseek-ai/dsh-client-ui-renderer/client`（type-only import + tsconfig 引用）。
  - ui-ssh 单项目编译 0 错误，彻底脱离 client-runtime。
- `368e6e874c` ui-polish 的 `SettingsScope`（pricing-store.ts、background-runtime.ts）改从 `@deepseek-ai/dsh-client-ui-settings/client` 导入（fork 版是 upstream 的子集接口；消费方只用 getSnapshot/subscribe/set/unset，机械迁移）。
- `index.ts` `ClientContext` → cordis `Context`（照 ui-ssh 范式；补 ui-renderer/client 的 ctx.slots 增广导入）。
- `model-index.ts`：4 个类型改从 `ui-conversation/client`；定义改写为符合 `ConversationNodeDefinition`（State=unknown 默认，upstream register 不收泛型子类型）；注册从 fork `ctx.conversationEvents` 迁到 upstream `ctx.uiConversation.events`（upstream 无 conversationEvents 服务）。
- 删除 `settled-diffs.ts` 与其 spec（无运行时消费者；基于将退役的 fork 转录模型；upstream `ToolResultNode` 不带 resultView.card/diffs 客户端视图，diff 卡语义只在 host 端 tool-fs presentation）。已记入本文件。
- tsconfig 引用修复：ui-ssh/ui-polish 的 client 项目补 `../store`（client-store）、`../ui-renderer` 引用。

## 关键架构结论（决定剩余工作量）

- upstream `ConversationSnapshot`（ui-conversation）只有 `views`/`activeTargets`；**没有** fork 的 `chat.nodes` 树。fork 的会话转录模型（`packages/client/runtime/src/client/sessions/conversation.ts`：ChatNode 按 kind 联合、tool-call 节点 `data.root` 带 `resultView.card==='diff'|'read'` 渲染意图）是 fork 自研，upstream 无等价物。
- fork `WorkspaceListState`（runtime workspaces/service.ts）引用已删语义（RpcError/WorkspaceView）；ui-polish 三个面板实际通过 slot 注入的 `useSession/useWorkspaces` hooks 取数，`WorkspaceListState` 只用于推导 workspace 路径。
- client-runtime 现被消费方：ui-polish（index/ExcalidrawPanel/GitPanel/MutationDiffPanel/StatsFloat/model-index/settled-diffs + tests）、runtime 自身 tsdown/tests。ui-ssh 已完全脱离。

## 剩余 client 类型错误（基线 65）

- 60 个在 `packages/client/runtime/tests/*`（fake-api/slots-service/scope/client-apply/wire-events/session/queue-store）：退役 runtime 时随包删除。
- 4 个 ui-polish 测试（stats-float/mutation-diff/background-row/apply.client.spec）。
- 1 个无文件归属 TS2878：**来自 runtime 项目自身**（程序构造错误，掩蔽其下 ~63 个遗留符号错误：connection **root/host 面**符号 SubagentAddress/JobView/DirectoryEntry/DirectoryListing/WorkspaceId/WorkspaceView/SessionId、api-remotes 的 ToolEventView、ui-slots 的 SessionMaybeProvideInfo 等在合并后 upstream 均不存在）。runtime 是待退役的 @reachforstar 包，无法在不整包迁移的前提下修绿；它被 ui-polish（面板+测试）与 ui-ssh 曾经的 tsconfig 引用拖入 client 图，直到 ui-polish 迁移完才能移除。
- ui-polish src 已 0 错（settled-diffs 删除后 ChatNode/TS2305 清零）。

## 下一步（B：逐面板迁移到 upstream 数据源，每步跑通 client 契约再继续）

1. StatsFloat/settled-diffs 的会话转录读取：弄清 StatsFloat 运行时从哪里拿 `ConversationSnapshot`（slot 注入？runtime hooks？），再对照 ui-conversation `ConversationNodeAssembler` + api-session-controller `SessionSnapshot` 重建；diff/read 卡语义需等 upstream 工具结果事件（host presentation 不下发到客户端）设计落地。
2. MutationDiffPanel/GitPanel/ExcalidrawPanel/SshPanel：`useSession/useWorkspaces` 改连 upstream 会话/工作区 store（PropsRuntime<'conversation.view'> 由 ui-slots 定义）；确认上游工作区路径推导 API（ui-workspace）。
3. StatsFloat 的模型定价：模型索引已注册到 ctx.uiConversation.events（本次完成），但需验证 upstream 汇编引擎对无 target 的 state-only Definition 是否真的会为每会话构建 Context（否则定价 feeder 失效需换实现）。
4. 相关 host 服务（git-service/excalidraw-service/background-service 等）核对是否还依赖已删模块。
5. 测试逐文件迁移/重写（keyless recorded-session snapshot 政策见 docs/testing.md）。
6. 退役 `packages/client/runtime`（删包 + workspace/tsconfig/pnpm-lock 引用 + 移除 runtime 测试 60 错）前确保无面板 import 它（ui-polish 的 StatsFloat/三面板 + 4 测试文件）。
7. 全绿 `pnpm run typecheck` 后 push。

## 已知问题与风险

- runtime 项目的独立 TS2878（无文件名）是程序构造错误，掩蔽其下 ~63 个遗留引用错误；未退役前会持续让 client 契约红 1 个错误。修复或退役 runtime 是唯一出路（本会话尝试将值导入改 /client 与补 references 均未根本解决，且会暴露被掩蔽的错误）。
- tsconfig.base 手写区含 `@reachforstar/*` 别名（含指向 lib 产物的 /types、/remote 两条，属 artifact-plane 例外，仅用于生成/跨包类型；勿被 gen-tsconfig-paths 覆盖，其生成区在 `// BEGIN generated package aliases` 之后）。
- 未 push；host 类型 0 错误；client 契约（tsc -b tsconfig.client.json）仍 65 错误（60 runtime 测试 + 4 ui-polish 测试 + 1 runtime TS2878）。
- tmp/ 下有 typecheck 日志（clientcheck*.log、uipolish*.log、rt*.log 等）。

## 复现与运行

- host 类型：`pnpm exec tsc -b tsconfig.host.json`
- client 契约：`pnpm exec tsc -b tsconfig.client.json`（全量更慢）
- 单包：`pnpm exec tsc -b packages/client/<pkg>/tsconfig.json --force`
- 构建产物：`pnpm run build:lib:host`（tsdown，生成 typert /remote 类型）
- 完整门禁：`pnpm run typecheck`（= build:lib:host + typecheck:contracts-ready）
