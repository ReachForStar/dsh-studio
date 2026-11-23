---
kind: upgrade-guide
description: "从 qwen-code、pi、opencode、codex 与 ZCode 采纳的二十一个包被移除，其预设行、工具、命令与配置键一并消失。"
---
# 从外部 harness 采纳的能力被移除

[English](guide.md) | 中文

## 变更

为 qwen-code、pi、opencode 与 codex/ZCode 能力计划新增的包已删除。仍在预设或 `cordis.yml` 中引用它们的部署加载失败。

被移除的包名：`dsh-agent-plugins`、`dsh-tool-search`、`dsh-arena`、`dsh-memory-notes`、`dsh-step-summary`、`dsh-followup`、`dsh-speculation`（含 `dsh-speculation/runner`、`/overlay`）、`dsh-codemode`、`dsh-agent-virtual-model`、`dsh-git-checkpoint`、`dsh-handoff`、`dsh-prompt-templates`、`dsh-input-handled`、`dsh-command-label`、`dsh-warming`、`dsh-fork-notice`、`dsh-openapi-tools`、`dsh-test-support-http-cassette`、`dsh-client-ui-markdown-mermaid`、`dsh-btw`，以及 `dsh-webhook` 的消息投递动作。

被移除的模型可见工具：`tool_search`、`watch_mcp_resource`、`memory_write` 与 codemode 的 `run_code`。被移除的命令：`/handoff`、`/checkpoint`、`/label`、`/btw`、`/full-access`、`/correct`、`/allow`。默认 Web 预设不再启用 `apply_patch`。

`mcp-client` 移除的配置键：`resourceWatchTimeoutMs` 与 `maxResourceWatchTimeoutMs`。审批规则（`rules`、`match`、项目允许清单、始终允许）一并消失，`approval/policy` 只接受 `ask` 与 `never`。

此前录制的会话仍可读：其中的事件类型与消息来源声明仍然保留。

## 迁移

1. 从预设补丁、`cordis.yml` 与 bundle 清单中删除全部被移除的包名。`pnpm dsh doctor` 会在启动前报告未知插件。
2. 删除配置中 `mcp-client` 的被移除键，以及 `toolSearch`、`sdkBudgetTokens`、推测执行相关设置。
3. 把提示词或技能里的 `tool_search`、`memory_write` 改为普通工具调用；把 `watch_mcp_resource` 改为轮询 `read_mcp_resource`。
4. 若依赖 `apply_patch` 默认开启，请在预设中显式加入。
5. 启动常用预设，确认 harness 能启动并跑完一个轮次。
