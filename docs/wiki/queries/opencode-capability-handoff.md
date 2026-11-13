---
title: opencode 能力落地交接（余 1 项）
type: query
tags: [交接, opencode, 权限规则, MCP OAuth, 代码模式, 侧问面板, 会话导入]
created: 2026-11-13
updated: 2026-11-13
sources: []
status: draft
---

# opencode 能力落地交接（余 1 项）

## 一句话结论

前 15 项已实现并推送，权限规则化含求值、静态扫描、项目持久规则、始终允许与修改后允许。下一会话只剩 MCP OAuth 与连接池，细则见 [MCP 连接池与 OAuth 交接](mcp-pool-oauth-handoff.md)。清单依据见 [能力面与可融入清单](opencode-v2-capability-comparison.md)。

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
| 项目规则与始终允许 | `packages/interaction/user-approval` 的 `approval_rules` 域与 `/allow`；`packages/client/ui-approval` | 服务 61 项、客户端 46 项 |
| 修改后允许 | `/correct` 命令与拒绝原因回传；审批面板纠正输入框 | 管道与客户端测试 |
| 侧问面板（btw） | `packages/experimental/btw` 的 `POST /api/btw.ask` 与 Session Header 弹窗 | 12 项测试，新文件覆盖率 100% |

行为取舍记录在 [循环与工具行为](../../../.agents/notes/implemented/feature/2026-11-12-opencode-core-behaviors.md)。

## 待办：MCP OAuth 与连接池

已拆分为独立交接：[MCP 连接池与 OAuth 交接](mcp-pool-oauth-handoff.md)。

## 全局约束与验证

- 不改 `packages/experimental/speculation` 的未提交改动；不删除 `docs/raw/` 既有文件。
- 提交信息 `type(scope): 摘要`；只暂存具体文件；推送 `me/develop`。
- 最小验证：`pnpm run typecheck`、受影响包 `pnpm exec vitest run <paths>`、`pnpm run build:artifacts && pnpm run build:check`、`pnpm run test:docs`、`pnpm run verify-cordis-catalog`（改配置/服务面时）。
- 新增包按 `packages/AGENTS.md` 与客户端新包清单接线：`tsconfig.base.json` paths、`tsconfig.host.json`/`tsconfig.client.json` references、`bundle/web-app` 行与依赖、README（含 Model Experience 与已知限制）、双语配对记录。

## 已知缺口（前 14 项遗留）

- `snapshots/web/web-search-round/ui.expected.md` 未刷新：来源面板新增 “Sources · N” 行会改变该金样，需在干净树执行 `pnpm run test:web:refresh`。
- `packages/experimental/openapi-tools` 未达到每文件 100% 覆盖率门禁，只补了行为测试。
- `warming` 的 `auto` 间隔固定 4 分钟（模型元数据没有缓存 TTL）。
- `mcp-manager` 的 Settings 未暴露资源等待配置（`resourceWatchTimeoutMs`、`maxResourceWatchTimeoutMs`）。
- `tool-executor-ptc` 的 `ptc.spec.ts` 有一条既有失败（`rejects invalid timeout 1000 before runtime execution`），与本轮改动无关；`tools.spec.ts` 的 bash 三条 schema 校验用例同样在改动前即失败。
- 会话导入没有浏览器入口；导入的 fork 历史会变成普通历史；附件摘要不一致时拒绝导入。
- 侧问面板是弹窗而非右侧栏；每次提问会留下一个 fork 子会话条目。

## 临时文件（待授权清理）

`tmp/task-opencode-impl.md`、`tmp/stage-list.txt`、`tmp/cov-mermaid/`、`tmp/coverage-ui-chat/`、`tmp/cov-src/`、`tmp/task-chat-mermaid.md`、`tmp/task-openapi-tools.md`、`tmp/task-mcp-resource-watch.md`、`tmp/tsconfig*.json`、`tmp/test-gui.log`、`tmp/*.tgz`、`tmp/cov*.log`。`tmp/opencode` 是参考源码，保留。
