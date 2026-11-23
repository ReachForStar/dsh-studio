---
title: opencode 能力采纳与回退
type: query
tags: [opencode, 能力对比, 回退, 持久化兼容]
created: 2026-11-12
updated: 2026-11-23
sources: []
status: active
---

# opencode 能力采纳与回退

## 问题

对照 opencode v2.2.7 评估可采纳能力，17 项于 2026-11-12 至 11-13 落地，2026-11-23 回退。本页记录采纳范围、落点与回退后的保留面。

## 采纳与回退清单

| 能力 | 落地落点 | 回退方式 |
| --- | --- | --- |
| 提示缓存保活 | `packages/experimental/warming` | 删除包与产品登记 |
| HTTP 卡带录制回放 | `packages/test-support/http-cassette` | 删除包 |
| OpenAPI 转工具 | `packages/experimental/openapi-tools` | 删除包 |
| 流式 Markdown 尾部修复 | `packages/client/ui-primitives` 的 `heal.ts` | 删除修复文件 |
| 聊天内 Mermaid 渲染 | `packages/client/ui-markdown-mermaid` | 删除包 |
| 输出上限续跑 | `packages/core/agent-loop` 的 `maxOutputContinuations` | 删除配置与分支 |
| fork 归属提示 | `packages/experimental/fork-notice` | 删除包 |
| 工具输入参数修复 | `packages/core/tools` 的 `repairArgs` | 删除修复器 |
| MCP 资源订阅 `watch_mcp_resource` | `packages/mcp/mcp-client` 与 `packages/mcp/mcp-resources` | 删除订阅注册表与工具 |
| 按轮 Web 来源 | `packages/client/ui-chat` 的 `turn-sources` 节点 | 删除节点与样式 |
| PTC SDK 声明预算 | `packages/core/tool-executor-ptc` 的 `sdk-catalog.ts` | 删除目录生成 |
| 会话日志导入 | `packages/session-query/session-log-export` 的 `importer.ts` | 删除导入器与路由 |
| 审批规则求值 | `packages/interaction/user-approval` 的 `rules.ts` | 删除规则求值 |
| 项目允许与始终允许 | `user-approval` 的 `approval_rules` 域与 `/allow` | 删除持久域与命令 |
| 修改后允许 | `/correct` 与拒绝原因回传 | 删除命令与面板输入 |
| PTC 工具静态扫描 | `tool-executor-ptc` 的 `scan.ts` | 删除扫描器 |
| MCP 共享连接池 | `packages/mcp/mcp-client` 的 `pool.ts`、`pool-key.ts` | 删除连接池与租约 |
| MCP 服务器设置授权界面 | `packages/client/ui-settings-mcp` | 删除包与设置页接线 |
| 侧问面板 | `packages/interaction/btw` | 删除包 |

MCP OAuth（授权授予、被动刷新、显式授权）来自上游提交，不在回退范围。

## 回退后保留的持久化兼容

`followup`、`tool-summary` 之外，opencode 侧写入的持久面只有消息来源 `memory-notes`（由 qwen 侧引入的同名能力）。声明保留在 `packages/core/session/src/retained-events.ts`，理由见 [qwen-code 能力采纳与回退](qwen-code-capability.md)。

## 不融入项

Effect/Drizzle 运行时、Rust daemon、插件 bundle 沙箱。

## 复发预防

- 连接池与资源订阅改动了 `mcp-client` 的世代管理；再次引入时先补 `connection.ts` 的隔离测试，不要只测工具面。
- 审批规则与 `permission-presets` 双向依赖：删规则求值时要同时清理 `registerFullAccess` 一类服务字段与全部测试桩。

## 关联页面

- [回退 qwen-code 能力](qwen-code-capability.md)
- [回退 pi 能力](pi-capability.md)
- [回退 codex 与 ZCode 能力](codex-zcode-capability.md)