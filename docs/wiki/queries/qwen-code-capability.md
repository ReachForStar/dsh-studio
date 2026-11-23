---
title: qwen-code 能力采纳与回退
type: query
tags: [qwen-code, 能力对比, 回退, 持久化兼容]
created: 2026-11-11
updated: 2026-11-23
sources: []
status: active
---

# qwen-code 能力采纳与回退

## 问题

对照 `github.com/QwenLM/qwen-code`（本机检出于 `6a999b20b7`）评估可采纳能力，逐项落地后再整体回退。本页是这次往返的唯一记录：采纳了什么、落在哪里、为何回退、回退后保留了什么。

## 采纳与回退清单

全部提交在 `develop` 上，落地时间 2026-11-11 至 11-12，回退时间 2026-11-23。

| 能力 | 落地落点 | 回退方式 |
| --- | --- | --- |
| Agent Plugins v1 加载器 | `packages/boot/agent-plugins` | 删除包与出厂组合接线 |
| 工具检索 `tool_search` | `packages/core/tool-search` | 删除包 |
| worktree 未提交改动镜像 | `packages/experimental/worktree` 的 `mirrorUncommitted` | 删除镜像参数与测试 |
| 上下文成本逐项与空闲成本 | `packages/llm/token-meter` 的 `contextBreakdown` | 删除 `idleCostTokens` 与逐工具条目 |
| 记忆笔记注入 | `packages/context/memory-notes` | 删除包 |
| 工具批次快模型摘要 | `packages/context/step-summary` | 删除包 |
| 轮次结束下一步建议 | `packages/context/followup` | 删除包 |
| 推测执行门控、overlay 与预测运行方 | `packages/core/speculation` | 删除包 |
| Arena 多模型对比 | `packages/core/arena` | 删除包与子系统页 |
| 通道投递到活跃会话 | `packages/experimental/webhook`（`WebhookMessageRequest`） | 删除投递分支与 `message.ts` |
| 出厂组合接线 | `packages/bundle/web-app` 的 8 行 | 删除 |

## 回退后保留的持久化兼容

被删包写了 4 个 log-only 会话事件与 4 种消息来源。声明改由 `packages/core/session/src/retained-events.ts` 承担：`followup/suggestions`、`tool/batch-summary`、`speculation/proposal`、`speculation/outcome`、`dsh-arena`、`dsh-speculation`、`followup`、`tool-summary`。发布版录下的会话因此仍可读，本构建不再折叠这些事件，也不再产生这些来源。

记录见 [持久化类型历史](../../../docs/persistence-changes/2026-11-23-retain-removed-fork-events.md)。

## 未采纳项

文件历史快照与撤销、Advisor 第二意见、文件变更钩子、`--json-schema` 结构化输出、托管运行时后端抽象。取舍依据是两边形态不同：qwen-code 是单体 CLI，本仓库是 Cordis 插件树，只能取能力语义。

## 复发预防

- 删除包前先确认它写了哪些 `SessionEventMap` 与 `MessageSourceMap` 成员；缺一个都会让旧会话读取失败。
- 生成的目录与图表由 `gen-*` 脚本重建，不要手改 `docs/*catalog*.md` 与 `module-graph*`。

## 关联页面

- [回退 codex 与 ZCode 能力](codex-zcode-capability.md)
- [回退 pi 能力](pi-capability.md)
- [回退 opencode 能力](opencode-capability.md)