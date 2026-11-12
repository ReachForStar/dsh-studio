---
title: QwenLM/qwen-code 能力面与可融入清单
type: query
tags: [对比分析, qwen-code, 能力缺口, 插件生态, 记忆, 上下文成本, 推测执行]
created: 2026-11-11
updated: 2026-11-11
sources: []
status: draft
---

# QwenLM/qwen-code 能力面与可融入清单

## 问题

qwen-code 源码在 `tmp/qwen-code`（main 分支 `6a999b20b7`）。对照本 fork 的 `packages/` 现状，找出可直接融入或值得借鉴的能力，并给出落点、成本与风险。

## 实施进度

| 项 | 状态 | 落点 |
| --- | --- | --- |
| Agent Plugins v1 加载面 | 已实现 | `packages/experimental/agent-plugins`（[实体页](../entities/agent-plugins.md)） |
| 工具检索（qwen `tool-search.ts`） | 已实现 | `packages/experimental/tool-search`（[实体页](../entities/tool-search.md)） |
| Arena 前置：worktree 脏状态镜像 | 已实现 | `packages/experimental/worktree` 的 `mirrorUncommitted` 与 `mirrorMaxFileBytes` |
| 上下文成本逐项 / idle cost | 部分实现 | `contextBreakdown` 增加 `idleCostTokens` 与逐工具 `tools`（见 [tool-search 实体页](../entities/tool-search.md) 的待确认小节）；文件/技能条目级与 `/context detail` 展示未做 |
| 快模型三件套 | 未实现 | 新增 fastModel 配置；摘要与建议需要新的展示数据通道 |
| 记忆层 | 未实现 | 注入需可重建的上下文来源，提取走后台 subagent |
| 通道运行时 | 未实现 | 需要把 `webhook` 泛化并新增活跃会话投递接缝 |
| Arena 本体 | 未实现 | 依赖脏状态镜像（已具备）与多会话并行编排 |

## 判定口径

- 插件化判定沿用 [合并上游 2026-11-08](upstream-merge-2026-11-08.md#第-3-项插件化分类)：只依赖已发布公开接缝、不改 harness 源码的算可插件化。
- 结论来自实际读取两边的源码与文档，未运行任何一方的代码，也未编译。
- 两边形态不同：qwen-code 是单体 CLI（`packages/cli` 3409 个文件、`packages/core` 2161 个源文件，能力按目录切分），本 fork 是 Cordis 插件树（能力按包切分）。只能取能力语义，不能照搬代码组织。

## 结论：优先级与落点

### 1. Agent Plugins v1 原生加载与第三方插件格式转换

qwen-code 已原生加载可移植的 [Agent Plugins v1](https://agent-plugins.org/)（根 `plugin.json` + `skills/*/SKILL.md` + 可选 `mcp.json`），安装时不改写标准文件；另有 `claude-converter.ts`、`gemini-converter.ts`、`qoder-converter.ts` 把 Claude、Gemini、Qoder 包转换成自身格式，配套 `marketplace.ts`、`npm.ts`、`zip-extraction.ts`、`network-policy.ts`、`redaction.ts`、`archive-safety.ts`（`packages/core/src/extension/`、`docs/users/extension/agent-plugins.md`、`docs/design/agent-plugins-v1-native-support.md`）。

本 fork 现状：`packages/experimental/claude-code-mods`（加载 Claude Code mods 的钩子链）、`packages/experimental/hooks-claude-code`、`packages/experimental/hook-protocol` 只覆盖钩子；`packages/extensions/*` 是模型现场写 Cordis 双面插件的运行时；`packages/experimental/plugin-market-bundle` 只浏览 Cordis bundle 索引。没有第三方插件包格式的加载面。

融入方式：新增 host 插件，把 `plugin.json`、`skills/`、`mcp.json` 映射到既有 `ctx.skill` 与 `ctx.mcp` 接缝，复用 `hook-protocol`。收益是直接接入 Claude Code / Codex / Qwen 生态。风险点是 qwen 那份设计里明确的包边界校验（manifest 逃逸拒绝整个插件、组件目录逃逸只关该组件、技能与 MCP 条目逃逸只跳该条目）、符号链接与网络策略、密钥扫描，需逐条照做。

### 2. 自动记忆、清理与团队记忆

`packages/core/src/memory`（104 文件）实现四个部分：会话结束后台提取（四类内容，`extract.ts` 与 `extractionAgentPlanner.ts`）、`MEMORY.md` 索引重建与双预算裁剪（`indexer.ts`、`index-budget.ts`，200 行 / 25000 UTF-16 单元，超限整条跳过、不切链接）、`pinned/` 只读保护区与 `dream` 每日去重清理（`dream.ts`、`dreamAgentPlanner.ts`）、`search_memory` 结构化召回（`search-memory.ts`、`recall.ts`、`metadata-migration.ts`）；团队记忆写仓库内目录并做密钥扫描与可选 git 同步（`team-memory-sync.ts`、`team-memory-secret-guard.ts`）。另有从话题学习技能的 `learn-skill-agent.ts`。文档见 `docs/users/features/memory.md`。

本 fork 现状：只有 `packages/context/agent-instructions`（用户级 + 项目级 `AGENTS.md` 链，首请求加载，按字节预算截断，`context.source.kind === 'agent-instructions'` 进会话事件）。写入侧持久记忆完全缺失。

融入方式：新组 `packages/memory/*`，注入侧沿用 agent-instructions 的 context source 形态以保证「模型可见⟺日志」，提取与清理走后台 subagent，召回做成按需工具。qwen 的双预算、`pinned/` 边界（含符号链接解析后的写入、编辑限制与无 shell 的 worker 策略）可直接沿用其参数与边界。

### 3. 通道运行时（IM、邮件、代码托管）

`packages/channels`（270 文件）用 `qwen channel start` 起单个 ACP agent 进程，接 Telegram、微信、QQ、钉钉（含 Webhook 单向发送）、企微、飞书、GitHub、GitLab、邮件；每通道有独立 `cwd`、`model`、`instructions`；`sessionScope` 四档、`sessionRotation`、`multiSession` 八任务、`privatePolicy` 四档含 DM 配对、`operators` 共享会话管理权、`messageRoutes` 前缀路由、`dispatchMode` 三档（`steer`/`collect`/`followup`）、`groupHistoryLimit` 群聊回填、独立的 `channel memory`（`docs/users/features/channels/overview.md`、`docs/developers/channel-plugins.md`）。

本 fork 现状：`packages/webhook` 是入站规则运行时（签名 HTTP → 创建 Workspace 会话），`packages/experimental/webhook-github` 是唯一平台适配器。

融入方式：把 webhook 运行时泛化为通道运行时，Service Definition 拆成适配器（收）/ 会话路由（作用域 + 认领）/ 投递（回复）三个角色，GitHub 适配器退化为一个 provider。`dispatchMode` 与本仓已有的引导与排队投递词汇同构。难点是投递到活跃会话需要公开接缝，属核心能力，不能只靠插件。

### 4. 上下文成本治理与工具检索

qwen 有 `/context detail`（逐项列出每个内置工具、MCP 工具、上下文文件、技能条目的本地估算）、`idle cost` 指标（只问一句不调工具的输入 token）、`tools.eager` 白名单与 `tools.toolSearch.threshold`（默认 0，即不预加载），配套 qwen-code 源码的 `tool-search.ts` 让模型按需检索并调用（`docs/users/features/context-cost.md`）。

本 fork 现状：`packages/llm/token-meter` 的 `contextBreakdown` 只有 `systemTokens`、`toolsTokens`、`messageTokens` 三个总数（`packages/llm/token-meter/src/projection.ts`）；`packages/core/tools` 的 `deferLoading: true` 只是声明，`packages/llm/llm/README.md` 记录其 provider 侧的执行限制；没有面向模型的工具检索工具（全仓 `tool_search` 只在 `packages/llm/llm-pi-ai` 测试里出现）。

融入方式：① 扩 `contextBreakdown` 到逐项，并把 idle cost 作为统计口径（改核心包，属 fork 补丁）；② 新增 `tool_search` 工具与 `deferLoading` 配套（可插件化）。

### 5. 快模型三件套：推测执行、下一步建议、工具批次摘要

同一份 `fastModel` 配置驱动三件事：

- 推测执行：`qwen-code 源码的 `followup/`/{speculation.ts,overlayFs.ts,speculationToolGate.ts}`。建议一出现就用 fork 的 LlmChat 在后台跑，写操作重定向到写时复制 overlay 目录，读优先 overlay；用户接受则把 overlay 拷回真实文件系统（`overlayFs.ts` 头部注释与 `acceptSpeculation`）。工具门只在 `auto-edit` / `yolo` 审批模式下把写工具重定向到 overlay，默认与 plan 模式下一律 `boundary` 停止推测，注释里写明「推测执行绕过正常审批流程」。
- 下一步建议：`suggestionGenerator.ts`，回合结束给一条建议，回车接受、Tab 编辑后再发。
- 工具批次摘要：批次结束后异步调快模型，输入工具名与截断到 300 字符的参数与结果，要求过去式、30 字符、git 提交标题风格标签，作为 `tool_use_summary` 记录（`docs/users/features/tool-use-summaries.md`）。

本 fork 现状：无 `fastModel` 概念（`fastModel` 仅出现在 subagent 的模型选择测试里）；无回合后建议；工具批次无摘要，只有 `packages/client/ui-input-trigger` 的输入框菜单与 `ui-action-cards` 的工具卡。

融入方式：摘要与建议做成纯展示层插件（不进模型上下文，天然满足「模型可见⟺日志」）；推测执行需要写时复制 overlay 与工具门，属新能力，可先只做读工具推测，写重定向依赖审批模式。

### 6. Arena（多模型对决）

`packages/core/src/agents/arena/{ArenaManager.ts,ArenaAgentClient.ts,diff-summary.ts,arena-events.ts}`：每个模型一个独立 agent 与独立 worktree，逐个启动并行执行，结束后给状态、时长、轮次、token、工具调用数、共同改动与独有改动、按 diff 的思路摘要，选中胜者把 diff 应用到主工作区并清理。worktree 的脏状态镜像在 `packages/core/src/services/gitWorktreeService.ts`：`git stash create` 取已跟踪改动，未跟踪文件单独复制进每个 worktree（约 1452–1530 行），另处理符号链接的配置目录与 submodule（`docs/users/features/arena.md`）。

本 fork 现状：`packages/experimental/worktree` 只从本地 commit 建隔离 checkout（README 原句：Create an isolated checkout from a local commit），不镜像未提交改动。无多会话对比与应用胜者。

融入方式：先给 worktree 补脏状态快照能力（属核心或新增接缝），再做 Arena 插件；对比视图可在 Web 客户端插件里做。

### 7. 文件历史快照与撤销

qwen-code 源码的 `fileHistoryService.ts` 与 qwen-code 源码的 `managed-tool-file-history.ts` 在编辑前留快照，按会话维度序列化留存，供撤销/回滚。

本 fork 现状：`packages/deliverables` 记录工作区变更，`packages/session/session-checkpoint-policy` 是持久化检查点，两者都不是文件级回滚。

融入方式：独立插件，挂在 `ctx.fs` 写入路径上留快照；注意与 file policy、sandbox 的写入边界一致。

### 8. Advisor（第二意见工具）

qwen-code 源码的 `advisor.ts` 是一个无参数工具：把当前对话转发给配置的顾问模型，取独立意见（`ADVISOR_DESCRIPTION` 原文：Get an independent second opinion on an approach, recurring failure, or completion）。

本 fork 现状：`packages/subagent` 可委派任务，`packages/experimental/subagent-oar` 有评审角色，但没有「对当前对话要第二意见」的一键入口。

融入方式：轻量插件工具，复用 subagent 的模型解析与 forked session。

### 9. 文件变更触发钩子

`docs/users/features/file-changed-hooks.md`：`FileChanged` 事件，按文件名或目录匹配、支持工作目录外路径、动态更新观察路径，并写明观察限制。

本 fork 现状：`packages/experimental/hook-protocol` 只支持提示词与工具调用两类拦截、附加上下文、停止。

融入方式：hook-protocol 增加事件源与匹配规则，复用 `ctx.fs` 的写入通知。

### 10. 结构化输出 `--json-schema`

`docs/users/features/structured-output.md`：headless 专用，注册一个合成的终止工具，模型必须调用，参数按 schema 校验，首次合法调用结束运行，text 模式下 stdout 只输出 JSON 一行，失败时 stdout 为空、错误进 stderr。

本 fork 现状：`packages/sdk` 是 JSON-RPC 面，工具输出支持任意 JSON 根，但没有「约束最终答案 + 合成终止工具」。

融入方式：要动 agent-loop 终止条件与 headless 输出约定，按仓库规则须同步 `docs/architecture.md`。

### 11. 托管服务端的运行时后端抽象（架构借鉴）

`packages/managed-agent-server` 是独立的 Spring Boot 控制面（13 个生产模块），带 `runtime-broker` 与 `runtime-local/http/ssh/kubernetes/static/external` 六种后端，租户由可信上游的 `X-Qwen-Tenant-Id` 断言，非回环地址强制签名认证（HMAC），本地嵌入 profile 会校验并缓存服务端 JAR。

本 fork 现状：`packages/api`（remote BFF）+ `packages/host` + `packages/remote`，没有多租户托管面。

判定：不照搬实现，只借鉴「运行时后端抽象 + 配置准入必须显式 + 本地嵌入形态」三点。

## 不建议融入

| 能力 | 原因 |
| --- | --- |
| 终端图片渲染（`display-image` / `zoom-image` / 终端内的图像协议） | 本 fork 没有 TUI（`packages/` 无 ink 依赖），主面是 Web 与桌面 |
| Dual output（`--json-fd` / `--json-file`） | `packages/sdk` 的 JSON-RPC 与事件流已覆盖 IDE/CI 观察者 |
| Agent Board（`~/.qwen/boards/` 文件级任务板） | `packages/team` 已有持久共享任务板、抢占与成员消息 |
| Batch 模式（DashScope 批量接口） | 绑定单一 provider，通用性低；后台任务已由 `packages/jobs` 覆盖 |
| Output styles、上下文提示（tips）、token 缓存展示 | 低价值或已在统计浮层里体现 |
| Auto Mode 分类器 | `packages/experimental/auto-review` 已按每次工具调用做模型判定 |

## 建议顺序

1. Agent Plugins v1 加载面（生态收益最大，可插件化）
2. 工具批次摘要与下一步建议（纯展示层，可与上一条并行）
3. 上下文成本逐项分解 + `tool_search`
4. 记忆层
5. 通道运行时（依赖活跃会话投递接缝）
6. Arena（依赖脏状态 worktree 快照）

## 待确认

- 上述每一条能否完全插件化，取决于本 fork 已发布接缝的实际能力（`ctx.context` 注入、会话投递、worktree 快照、`ctx.fs` 写入通知），动手前需逐条核对公开导出。
- Agent Plugins v1 规范原文（agent-plugins.org）未读，只读了 qwen 的实现与设计文档。
- qwen 的 `managed-runtime`（185 文件）与 `packages/core/src/omni`（93 文件）未逐文件读，可能还有可借鉴点未纳入。