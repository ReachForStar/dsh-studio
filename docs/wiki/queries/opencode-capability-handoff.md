---
title: opencode 能力落地交接（余 5 项）
type: query
tags: [交接, opencode, 权限规则, MCP OAuth, 代码模式, 侧问面板, 会话导入]
created: 2026-11-13
updated: 2026-11-13
sources: []
status: draft
---

# opencode 能力落地交接（余 5 项）

## 一句话结论

前 10 项已实现并推送（分支 `develop`，远程 `me`，共三次提交：能力落地、wiki 记录、MCP 收尾）。下一会话只需处理 5 项：权限规则化、MCP OAuth 与连接池、PTC 按需目录与静态扫描、侧问面板、会话导入。清单依据见 [能力面与可融入清单](opencode-v2-capability-comparison.md)。

## 已完成部分（不要重做）

| 项 | 落点 | 验证 |
| --- | --- | --- |
| 提示缓存保活 | `packages/experimental/warming` | 13 项测试 |
| HTTP 卡带 | `packages/test-support/http-cassette` | 19 项测试 |
| OpenAPI 转工具 | `packages/experimental/openapi-tools` | 30 项测试 |
| 流式尾部修复 | `packages/client/ui-primitives/src/markdown/heal.ts` | 覆盖率 100% |
| 聊天内 Mermaid | `packages/client/ui-markdown-mermaid` | 10 项测试 |
| 输出上限续跑 | `packages/core/agent-loop` 的 `maxOutputContinuations` | 循环测试 76 项 |
| fork 归属提示 | `packages/experimental/fork-notice` | 覆盖率 100% |
| 工具输入修复 | `packages/core/tools/src/schema.ts` 的 `repairArgs` | 覆盖率 100% |
| MCP 资源订阅 | `packages/mcp/mcp-resources` 的 `watch_mcp_resource` | MCP 307 项 |
| 按轮 Web 来源 | `packages/client/ui-chat` 的 `turn-sources` 节点 | ui-chat 1037 项 |

行为取舍记录在 [循环与工具行为](../../../.agents/notes/implemented/feature/2026-11-12-opencode-core-behaviors.md)。

## 待办 1：权限规则化

目标：`{action, resource, effect}` 通配规则求值、按项目持久化 allow 规则、用户改写参数作为反馈、无人值守规则。

现状与落点：

- 现有审批只有一次性 `allowed-once`（`packages/interaction/user-approval/src/types.ts`），策略只有 `ask` / `never`，权限粒度是预设（`packages/interaction/permission-presets`）。
- 参考实现：`tmp/opencode/packages/schema/src/permission.ts`（规则与 `Reply`）、`tmp/opencode/packages/core/src/permission.ts`（`CorrectedError`、`Unattended`）、`tmp/opencode/packages/core/src/permission/saved.ts`（持久规则）。
- 先定资源契约：审批请求需要携带 `action` 与资源列表。工具侧没有通用资源来源；建议在 `ToolDefinition` 增加可选的 `approvalResources(args)`，先给 `fs` 写/编辑与 `bash` 落地，其余工具只按工具名匹配。不要在 `AgentLoop` 或会话格式里塞规则。
- 持久规则落点用 `packages/storage`；客户端交互改 `packages/client/ui-approval`（新增「总是允许」与「修改后允许」）。
- 无人值守：`packages/schedule` 当前在无应答者时 fail-closed；规则求值应在其之前，只允许显式 allow 规则。
- 验收：规则求值纯函数单测、`tools/pre-execute` 真实路径拒绝/放行、持久规则跨重启、参数纠正回传模型、无人值守放行与拒绝各一条。

## 待办 2：MCP OAuth 与连接池

目标：远程 MCP 服务器 OAuth 授权；同一部署多个会话共享连接。

现状与落点：

- `packages/mcp/mcp-client` 有重连预算、`probe`、`restart` 与 `${credential:REF}` 模板；没有 OAuth，也没有连接池。
- SDK 为 `@modelcontextprotocol/client@2.2.0`，已确认支持 `resources.subscribe` 与新版 `listen`；OAuth 能力需现场确认（`node_modules/@modelcontextprotocol/client` 的 auth 导出）。
- 参考实现：`tmp/opencode/packages/core/src/mcp/oauth.ts`、`pool.ts`、`socket-client.ts`。
- 注意事项：凭据槽位沿用 `packages/credentials`；连接池只在同 key 多 Location 间共享，握手失败的服务器回退独占；不要改变现有 `ctx.mcpManager` 的公开面，除非确有必要。
- 验收：OAuth 授权流程（可先用本地 mock 授权服务器）、凭据刷新与失效、池化共享与释放、失败回退独占。

## 待办 3：PTC 按需目录与静态扫描

目标：`run_code` 的工具签名按预算下发 + 程序内 `search` 按需发现；`tools.*` 静态扫描供权限预判。

现状与落点：

- `packages/core/tool-executor-ptc` 每次请求下发完整生成 SDK（`renderToolsSdk`，README 写明成本与可见定义成正比）。
- 参考实现：`tmp/opencode/packages/core/src/codemode/catalog.ts`（`INLINE_BUDGET = 2000`、描述 120 字、增量补丁）、`instructions.ts`、`tmp/opencode/packages/codemode/src/tool-runtime.ts`（内建 `search` 与 BM25）、`scan.ts`（Acorn 静态提取）。
- 目录模式的难点是绑定：程序仍要能调用未展示的工具。两条路：① 只压缩展示（全部绑定仍存在，签名换成一行目录，`search` 返回完整签名）；② 运行时按需物化绑定（需改 `packages/ptc-runtime` 的沙箱注入面）。
- 建议先做 ①：不改运行时，改 `ts-types.ts`/`py-types.ts` 的渲染与新增程序内 `search`（若运行时不能注入全局，则把 `search` 作为普通工具再在目录里提示）。静态扫描可先做成纯函数包，接入定时任务的权限预判。
- 验收：目录预算与增量稳定性、`search` 命中与未命中、缓存前缀变化实测、扫描拒绝动态下标/别名。

## 待办 4：侧问面板（btw）

目标：侧栏就当前上下文问一句，不污染主会话。

现状与落点：

- 没有侧问；`packages/subagent` 只能委派并在主会话回报。
- 参考实现：`tmp/opencode/packages/gui-plugins/src/btw`（主/渲染进程状态机与面板）。
- 建议：客户端新包注册右侧栏面板；服务端复用 `subagent-fork-in-process` 的 fork 子会话或 `api/session-controller` 的 `fork` 命令（见 `commands.ts` 的 `fork`）。默认不把答案写回主会话；若写回，走 `Agent.inject` 并补会话事件。
- 注意：`packages/client/AGENTS.md` 的槽位与 props 纪律；文案走 typed locale；移动端与深色主题按 CSS 变量。
- 验收：面板开关、fork 会话隔离、答案不写主会话、取消与关闭清理、窄屏布局。

## 待办 5：会话导入

目标：导入本仓库导出的会话 ZIP，校验后成为新会话。

现状与落点：

- 只有导出：`packages/session-query/session-log-export`（`archive.ts`，fflate）。
- 参考实现：`tmp/opencode/packages/core/src/session/transfer.ts`（sanitize 导入）。
- 建议：读取 ZIP → 用 `session-format-catalog` 校验代际与事件 → 分配新 `SessionId` → 以完整日志为种子创建（`isSeeded` 语义要确认：导入不是分叉，可能需要普通 replay 而非 fork 标记，见 `packages/core/session/src/index.ts` 的构造校验）→ 写入 `session-persistence` → 挂到工作区。
- 风险：事件里的工具/来源类型在目标版本不存在时要明确拒绝而不是丢弃；附件需随 ZIP 恢复；不要复用源会话 id。
- 验收：同版本导入、跨代迁移、损坏 ZIP、未知来源事件、附件恢复、重复导入不覆盖。

## 全局约束与验证

- 不改 `packages/experimental/speculation` 的未提交改动；不删除 `docs/raw/` 既有文件。
- 提交信息 `type(scope): 摘要`；只暂存具体文件；推送 `me/develop`。
- 最小验证：`pnpm run typecheck`、受影响包 `pnpm exec vitest run <paths>`、`pnpm run build:artifacts && pnpm run build:check`、`pnpm run test:docs`、`pnpm run verify-cordis-catalog`（改配置/服务面时）。
- 新增包按 `packages/AGENTS.md` 与客户端新包清单接线：`tsconfig.base.json` paths、`tsconfig.host.json`/`tsconfig.client.json` references、`bundle/web-app` 行与依赖、README（含 Model Experience 与已知限制）、双语配对记录。

## 已知缺口（前 10 项遗留）

- `snapshots/web/web-search-round/ui.expected.md` 未刷新：来源面板新增 “Sources · N” 行会改变该金样，需在干净树执行 `pnpm run test:web:refresh`。
- `packages/experimental/openapi-tools` 未达到每文件 100% 覆盖率门禁，只补了行为测试。
- `warming` 的 `auto` 间隔固定 4 分钟（模型元数据没有缓存 TTL）。
- `mcp-manager` 的 Settings 未暴露资源等待配置（`resourceWatchTimeoutMs`、`maxResourceWatchTimeoutMs`）。

## 临时文件（待授权清理）

`tmp/task-opencode-impl.md`、`tmp/stage-list.txt`、`tmp/cov-mermaid/`、`tmp/coverage-ui-chat/`、`tmp/cov-src/`、`tmp/task-chat-mermaid.md`、`tmp/task-openapi-tools.md`、`tmp/task-mcp-resource-watch.md`、`tmp/tsconfig*.json`、`tmp/test-gui.log`、`tmp/*.tgz`。`tmp/opencode` 是参考源码，保留。