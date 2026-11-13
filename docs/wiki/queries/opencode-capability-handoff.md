---
title: opencode 能力落地交接（余 2 项）
type: query
tags: [交接, opencode, 权限规则, MCP OAuth, 代码模式, 侧问面板, 会话导入]
created: 2026-11-13
updated: 2026-11-13
sources: []
status: draft
---

# opencode 能力落地交接（余 2 项）

## 一句话结论

前 13 项已实现并推送，其中权限规则化交付了规则求值、工具侧动作/资源分类与无人值守放行，持久规则与客户端「总是允许 / 修改后允许」仍未做。下一会话只需处理 2 项：MCP OAuth 与连接池、侧问面板（btw）。清单依据见 [能力面与可融入清单](opencode-v2-capability-comparison.md)。

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
| PTC 按需目录 | `packages/core/tool-executor-ptc` 的 `sdkBudgetTokens`、`sdk-catalog.ts` | 包测试 281 项，新文件覆盖率 100% |
| 会话导入 | `packages/session-log-export/src/importer.ts`、`POST /api/session.import` | 包测试 150 项，`importer.ts` 覆盖率 100% |
| 权限规则求值 | `packages/interaction/user-approval/src/rules.ts`；`ToolDefinition.approvalResources`；fs `write`/`edit` 与 `bash` 分类 | 规则 6 项、服务 6 项、管道 2 项 |

行为取舍记录在 [循环与工具行为](../../../.agents/notes/implemented/feature/2026-11-12-opencode-core-behaviors.md)。

### 权限规则化的剩余缺口

已具备：`{action, resource, effect}` 的 `*` / `?` 通配求值（后匹配优先）、规则先于 `never` 策略（无人值守只放行显式 allow 规则）、`write`/`edit` 以 `write` 与路径分类、`bash` 以命令文本分类、分类函数抛出时回退工具名（只会更窄）。配置入口为 `dsh-user-approval` 的 `rules`。

未做：

- 按项目持久化 allow 规则（落点 `packages/storage`，用 `storageDomain` 存规则表；审批服务通过可选服务读取，不要塞进会话格式）。
- 客户端「总是允许」与「修改后允许」（`packages/client/ui-approval`）；后者需要把用户改写后的参数作为反馈回传模型，涉及一次新的服务端往返与会话事件。
- 计划任务的静态扫描（`tools.*` 提取），可在持久规则落地后作为预判复用；当前没有消费方，未引入。

## 待办 1：MCP OAuth 与连接池

目标：远程 MCP 服务器 OAuth 授权；同一部署多个会话共享连接。

现状与落点：

- `packages/mcp/mcp-client` 有重连预算、`probe`、`restart` 与 `${credential:REF}` 模板；没有 OAuth，也没有连接池。
- SDK 为 `@modelcontextprotocol/client@2.2.0`，已确认导出 `OAuthClientProvider`（`redirectUrl`、`clientMetadata`、`clientInformation`、`tokens`、`saveTokens`、`redirectToAuthorization` 等）；`resources.subscribe` 与新 `listen` 也已确认。
- 参考实现：`tmp/opencode/packages/core/src/mcp/oauth.ts`、`pool.ts`、`socket-client.ts`。
- 注意事项：凭据槽位沿用 `packages/credentials`；连接池只在同 key 多 Location 间共享，握手失败的服务器回退独占；共享连接需要独立服务承载（禁止模块级缓存），释放以最后一个引用为准；不要改变现有 `ctx.mcpManager` 的公开面，除非确有必要。
- 验收：OAuth 授权流程（可先用本地 mock 授权服务器）、凭据刷新与失效、池化共享与释放、失败回退独占。

## 待办 2：侧问面板（btw）

目标：侧栏就当前上下文问一句，不污染主会话。

现状与落点：

- 没有侧问；`packages/subagent` 只能委派并在主会话回报。
- 参考实现：`tmp/opencode/packages/gui-plugins/src/btw`（主/渲染进程状态机与面板）。
- 建议：客户端新包注册右侧栏面板；服务端复用 `subagent-fork-in-process` 的 fork 子会话或 `api/session-controller` 的 `fork` 命令（见 `commands.ts` 的 `fork`）。默认不把答案写回主会话；若写回，走 `Agent.inject` 并补会话事件。
- 注意：`packages/client/AGENTS.md` 的槽位与 props 纪律；文案走 typed locale；移动端与深色主题按 CSS 变量。
- 验收：面板开关、fork 会话隔离、答案不写主会话、取消与关闭清理、窄屏布局。

## 全局约束与验证

- 不改 `packages/experimental/speculation` 的未提交改动；不删除 `docs/raw/` 既有文件。
- 提交信息 `type(scope): 摘要`；只暂存具体文件；推送 `me/develop`。
- 最小验证：`pnpm run typecheck`、受影响包 `pnpm exec vitest run <paths>`、`pnpm run build:artifacts && pnpm run build:check`、`pnpm run test:docs`、`pnpm run verify-cordis-catalog`（改配置/服务面时）。
- 新增包按 `packages/AGENTS.md` 与客户端新包清单接线：`tsconfig.base.json` paths、`tsconfig.host.json`/`tsconfig.client.json` references、`bundle/web-app` 行与依赖、README（含 Model Experience 与已知限制）、双语配对记录。

## 已知缺口（前 13 项遗留）

- `snapshots/web/web-search-round/ui.expected.md` 未刷新：来源面板新增 “Sources · N” 行会改变该金样，需在干净树执行 `pnpm run test:web:refresh`。
- `packages/experimental/openapi-tools` 未达到每文件 100% 覆盖率门禁，只补了行为测试。
- `warming` 的 `auto` 间隔固定 4 分钟（模型元数据没有缓存 TTL）。
- `mcp-manager` 的 Settings 未暴露资源等待配置（`resourceWatchTimeoutMs`、`maxResourceWatchTimeoutMs`）。
- `tool-executor-ptc` 的 `ptc.spec.ts` 有一条既有失败（`rejects invalid timeout 1000 before runtime execution`），与本轮改动无关；`tools.spec.ts` 的 bash 三条 schema 校验用例同样在改动前即失败。
- 会话导入没有浏览器入口；导入的 fork 历史会变成普通历史；附件摘要不一致时拒绝导入。

## 临时文件（待授权清理）

`tmp/task-opencode-impl.md`、`tmp/stage-list.txt`、`tmp/cov-mermaid/`、`tmp/coverage-ui-chat/`、`tmp/cov-src/`、`tmp/task-chat-mermaid.md`、`tmp/task-openapi-tools.md`、`tmp/task-mcp-resource-watch.md`、`tmp/tsconfig*.json`、`tmp/test-gui.log`、`tmp/*.tgz`、`tmp/cov*.log`。`tmp/opencode` 是参考源码，保留。
