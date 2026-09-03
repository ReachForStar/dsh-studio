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

## 模型定价（StatsFloat）迁移关键发现（2026-09-03 续）

- **ui-chat 的 'chat' 目标快照自带 `legacy.nodes: readonly ConversationNode[]`**（ui-chat/src/client/contract/snapshot.ts，`ChatSnapshot.legacy: LegacyConversationSlice`，merge 进 `ConversationViewSnapshotMap['chat']`）——正是 fork runtime 拷贝的同款形状（`StatsFloat` 用的 `chat.legacy.nodes`）。
- upstream `AssistantMessageNode` **原生带 `usage`、`provenance: {provider, model}`、`timing`(stepStartTime/firstTokenTime/completedTime)、`messageId`、`time`/`turn`**；`ToolResultNode` 带 `time`/`callTime`。fork model-index 的前提（"upstream gap：节点无 model provenance"）在合并后的 upstream **已不成立**。
- 结论：StatsFloat 迁移 = `useConversation(s => s.views.get('chat')?.legacy.nodes)`（dock 的 SessionStandardProps 提供 useConversation）+ 每 assistant 节点 `provenance?.model` 当 modelOf + usage 适配（usage 字段形状可能需对 dsh-llm TokenUsage）；**model-index.ts（createModelIndex/modelIndexDefinition + index.ts 里 `ctx.uiConversation.events.register` 段 + 其 spec）可整体删除**（含 32a714e41a 刚接上的注册段）。StatsFloat 需确认 useProjection 在 dock PropsRuntime 的可用性（ui-renderer 增广）。
- 待办：删除 model-index 相关后，检查 index.ts 注入与 modelOf/card 注入契约变化。

## StatsFloat/模型定价 src 迁移完成（2026-09-03 续 2）

- StatsFloat.tsx 数据源改为 `useConversation(s => s.views.get('chat')?.legacy.nodes ?? [])`（dock 的 SessionStandardProps 由 ui-conversation 提供 useConversation；ui-chat 的 ChatSnapshot.legacy.nodes 即上游 ConversationNode[]）；每 assistant 节点用 `provenance?.model` 计价（不再需要 messageId→model 索引）；保留 useProjection('tokenUsage'/'sessionStats')（由 ui-session 增广提供，与 ui-renderer bindSnapshotSelector 无冲突）。
- **删除 model-index.ts + 其 spec**；index.ts 删除 createModelIndex/注册段与 modelOf 注入（dock 只注入 card），并从 inject 列表移除 uiConversation。
- ui-polish 引用新增 ui-chat/ui-session（增广来源，必须先引用否则 TS6059/TS6307 级联）；ui-polish src 0 错。
- 遗留：4 个 ui-polish 测试 spec（stats-float/mutation-diff/background-row/apply）需按 upstream 夹具重写（dock PropsRuntime 的 useSession 现为 ui-session 的 SessionSnapshotSelector 而非 fork ConversationSnapshot——测试需构造 upstream SessionSnapshot + ConversationSnapshot(views.get('chat')→ChatSnapshot)，assistant 夹具带 provenance.model、ToolResultNode 去掉 callView/resultView 字段）；stats-float spec 的错误已由此暴露（TS2322 useSession 类型不匹配）。

## 迁移过程状态（历史，2026-09-03 当日推进）

- 退役前 client 契约基线 65 错：60 runtime 测试 + 4 ui-polish 测试 + 1 runtime TS2878（无归属，掩蔽 runtime 自身 ~63 遗留符号错：connection host 面符号、ToolEventMap 等均已在合并后 upstream 消失）。
- 退役后（见下节“完成”）双侧 0 错。

## 迁移步骤（均已执行完毕，见“完成”节）

1. StatsFloat/settled-diffs 的会话转录读取：弄清 StatsFloat 运行时从哪里拿 `ConversationSnapshot`（slot 注入？runtime hooks？），再对照 ui-conversation `ConversationNodeAssembler` + api-session-controller `SessionSnapshot` 重建；diff/read 卡语义需等 upstream 工具结果事件（host presentation 不下发到客户端）设计落地。
2. MutationDiffPanel/GitPanel/ExcalidrawPanel/SshPanel：`useSession/useWorkspaces` 改连 upstream 会话/工作区 store（PropsRuntime<'conversation.view'> 由 ui-slots 定义）；确认上游工作区路径推导 API（ui-workspace）。
3. StatsFloat 的模型定价：模型索引已注册到 ctx.uiConversation.events（本次完成），但需验证 upstream 汇编引擎对无 target 的 state-only Definition 是否真的会为每会话构建 Context（否则定价 feeder 失效需换实现）。
4. 相关 host 服务（git-service/excalidraw-service/background-service 等）核对是否还依赖已删模块。
5. 测试逐文件迁移/重写（keyless recorded-session snapshot 政策见 docs/testing.md）。
6. 退役 `packages/client/runtime`（删包 + workspace/tsconfig/pnpm-lock 引用 + 移除 runtime 测试 60 错）前确保无面板 import 它（ui-polish 的 StatsFloat/三面板 + 4 测试文件）。
7. 全绿 `pnpm run typecheck` 后 push。

## 完成：client-runtime 退役，typecheck 全绿（2026-09-03 终）

- **ui-polish 三面板（Git/Excalidraw/MutationDiff）**：`WorkspaceListState`（fork runtime）→ `api-workspace-controller` 的 `WorkspaceView`；增广来源引用 ui-workspace/ui-session/ui-chat；props 的 useSession/useWorkspaces 现由 upstream 增广提供。
- **4 个 ui-polish 测试 spec 全部迁移到 upstream 夹具**（stats-float/apply/background-row/mutation-diff），ui-polish + ui-ssh 共 16 文件 115 测试通过；apply spec 按 locale spec 范式（SlotRegistry 插件挂载 + TestRemote settings 事件）重写。
- index.ts 的 inject 收敛为 `['slots','locale','settingsScope']`（connection/remote 不再被 apply 使用）。
- **退役 `packages/client/runtime`**：删除包 + ui-polish/ui-ssh 的 package.json 依赖、tsconfig 引用与 dsh inject 条目 + tsconfig.base 别名 + pnpm-lock。其 60 个测试错误与无归属 TS2878 随包消失。
- **`pnpm run typecheck`（build:lib:host + typecheck:contracts-ready）exit 0**；host/client 双侧 tsc 0 错误。lint（oxlint）对 ui-polish/ui-ssh 干净（SshPanel 换 `@deepseek-ai/dsh-util-crypto` 的 randomUUID，crypto-shim 保留平台豁免注释）。
- 全部分支提交于 master；待 push（push 钩子 = pnpm run typecheck，已手动跑通）。

## 里程碑状态

B（彻底迁移）实质完成：SSH 面板、模型定价（StatsFloat，删 model-index）、Git/Excalidraw/MutationDiff 面板均已迁移到 upstream 客户端栈；client-runtime 已退役。剩余可选收尾：
- `doc/` 后续演进记录；git-service/excalidraw-service 的 host 依赖核对（已在 host 契约绿）；SshPanel（ui-polish conversation.view 'ssh' 终端面板）与 ui-ssh（settings.section）为 fork 自研产品，已接 upstream 槽位，留意产品级回归测试。

## 复现与运行

- host 类型：`pnpm exec tsc -b tsconfig.host.json`
- client 契约：`pnpm exec tsc -b tsconfig.client.json`（全量更慢）
- 单包：`pnpm exec tsc -b packages/client/<pkg>/tsconfig.json --force`
- 构建产物：`pnpm run build:lib:host`（tsdown，生成 typert /remote 类型）
- 完整门禁：`pnpm run typecheck`（= build:lib:host + typecheck:contracts-ready）
