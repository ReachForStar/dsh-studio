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

## 关键架构结论（决定剩余工作量）

- upstream `ConversationSnapshot`（ui-conversation）只有 `views`/`activeTargets`；**没有** fork 的 `chat.nodes` 树。fork 的会话转录模型（`packages/client/runtime/src/client/sessions/conversation.ts`：ChatNode 按 kind 联合、tool-call 节点 `data.root` 带 `resultView.card==='diff'|'read'` 渲染意图）是 fork 自研，upstream 无等价物。
- fork `WorkspaceListState`（runtime workspaces/service.ts）引用已删语义（RpcError/WorkspaceView）；ui-polish 三个面板实际通过 slot 注入的 `useSession/useWorkspaces` hooks 取数，`WorkspaceListState` 只用于推导 workspace 路径。
- client-runtime 现被消费方：ui-polish（index/ExcalidrawPanel/GitPanel/MutationDiffPanel/StatsFloat/model-index/settled-diffs + tests）、runtime 自身 tsdown/tests。ui-ssh 已完全脱离。

## 剩余 client 类型错误（基线 ~66）

- ~60 个在 `packages/client/runtime/tests/*`（fake-api/slots-service/scope/client-apply/wire-events/session/queue-store）：退役 runtime 时随包删除。
- ui-polish src：settled-diffs 的 `ChatNode`（TS2305 + 独立 TS2878 跨项目）；测试 5 文件（stats-float/mutation-diff/background-row/apply.client.spec）。
- ui-polish 尚依赖 runtime 的类型：`ConversationSnapshot`（fork 模型）、`WorkspaceListState`、`ClientContext`（index.ts）、model-index 多处符号。

## 下一步（B：逐面板迁移到 upstream 数据源，每步跑通 client 契约再继续）

1. index.ts：`ClientContext` → cordis `Context`（照 ui-ssh 已完成范式；需拉 ui-renderer/client 增广、处理 `ctx.conversationEvents`/`ctx.settingsScope` merge 来源）。
2. settled-diffs/StatsFloat：把 fork 会话转录模型换到 upstream 会话/视图数据源。先弄清 StatsFloat/MutationDiff 运行时从哪里拿 `ConversationSnapshot`（slot 注入？runtime hooks？），再对照 ui-conversation `ConversationNodeAssembler` + api-session-controller `SessionSnapshot` 重建取数与 diff/read 卡语义（fork 产品价值）。
3. MutationDiffPanel/GitPanel/ExcalidrawPanel：`useSession/useWorkspaces` 改连 upstream 会话/工作区 store（PropsRuntime<'conversation.view'> 由 ui-slots 定义）；确认上游工作区路径推导 API。
4. 相关 host 服务（git-service/excalidraw-service/background-service 等）核对是否还依赖已删模块。
5. 测试逐文件迁移/重写（keyless recorded-session snapshot 政策见 docs/testing.md）。
6. 退役 `packages/client/runtime`（删包 + workspace/tsconfig/pnpm-lock 引用）前确保无面板 import 它。
7. 全绿 `pnpm run typecheck` 后 push。

## 已知问题与风险

- TS2878（无文件名）基线存在，与 settled-diffs 导入 ui-conversation/client（缺 ChatNode）跨项目解析相关；解决 ChatNode 后应消失，否则需追查。
- tsconfig.base 手写区含 `@reachforstar/*` 别名（含指向 lib 产物的 /types、/remote 两条，属 artifact-plane 例外，仅用于生成/跨包类型；勿被 gen-tsconfig-paths 覆盖，其生成区在 `// BEGIN generated package aliases` 之后）。
- 未 push；host 类型 0 错误；client 契约（tsc -b tsconfig.client.json）仍 ~66 错误。
- tmp/ 下有 typecheck 日志（clientcheck*.log、uipolish*.log 等）。

## 复现与运行

- host 类型：`pnpm exec tsc -b tsconfig.host.json`
- client 契约：`pnpm exec tsc -b tsconfig.client.json`（全量更慢）
- 单包：`pnpm exec tsc -b packages/client/<pkg>/tsconfig.json --force`
- 构建产物：`pnpm run build:lib:host`（tsdown，生成 typert /remote 类型）
- 完整门禁：`pnpm run typecheck`（= build:lib:host + typecheck:contracts-ready）
