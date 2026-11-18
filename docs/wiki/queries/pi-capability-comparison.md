---
title: pi（earendil-works/pi）能力面与可融入清单
type: query
tags: [对比分析, pi, 虚拟模型, 分类器, codemode, 提示模板, 沙箱, 压缩]
created: 2026-11-17
updated: 2026-11-17
sources: []
status: draft
---

# pi（earendil-works/pi）能力面与可融入清单

## 问题

用户给出上游仓库 `earendil-works/pi`，要求判断哪些能力可融入本 fork。本 fork 已把 Pi 运行时接成第二个会话后端（[pi 后端（pi-agent-loop）](../entities/pi-backend.md)），并接了 pi-ai 的多提供方运行时（[llm-pi-ai](../entities/llm-pi-ai.md)）。本次只找 pi 有、本 fork 还没有的部分。

## 判定口径

- 事实来源是**本机已安装的 pi 1.5.2**（`@earendil-works/pi-coding-agent` 及其子包，位于 `/home/asus/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/`），含 `docs/`、`examples/extensions/`、`schemas/` 与各包 README。GitHub 网络在本机被重置，未读仓库 main；结论对 1.5.2 有效，main 可能已前进。
- 只读文档、示例源码与本 fork 的 `packages/` README/源码，未编译、未运行 pi。
- 形态差异：pi 是单进程 agent harness，会话是带 `id`/`parentId` 的 JSONL 树；本 fork 是 Cordis 插件树，会话是 v5 线性事件 + 投影 + 世代迁移。只取能力语义与设计边界，不取存储格式。
- 已覆盖项先在本 fork 搜同义实现再排除，避免重复。

## 落地进度（2026-11-18 全部完成）

| # | 能力 | 状态 | 落点 |
| --- | --- | --- | --- |
| 8 | handoff | 已落地，提交 `9a79451953` | `packages/context/handoff`（`/handoff` 命令） |
| 4 | 提示模板 | 已落地，提交见 `feat(prompt-templates)` | `packages/interaction/prompt-templates`（模板→命令，展开进模型） |
| 6 | 会话标签 | 已落地，提交见 `feat(command-label)` | `packages/interaction/command-label`（`/label` + `session/label` 事件与投影） |
| 5 | 输入事件 handled | 已落地，`feat(input-handled)` | `packages/interaction/input-handled` + `session-controller` 准入 |
| 1 | 虚拟模型路由 | 已落地，`feat(agent-virtual-model)` | `packages/core/agent-virtual-model` + `dsh-agent`/`agent-loop` |
| 2 | classifier / image | 已落地，`feat(llm)` | `dsh-llm` 非 chat 契约 + `llm-pi-ai` 实现 |
| 7 | Git 检查点 | 已落地，`feat(git-checkpoint)` | `packages/experimental/git-checkpoint`（显式命令） |
| 3 | codemode | 已落地，`feat(codemode)` | `packages/experimental/codemode`（Node `node:vm`，无新依赖） |

落地过程附带清偿一处既有持久化债务：`event:agent/inbox/spliced` 的历史分叉（`2026-10-29-fork-message-source-kinds` 与 `2026-11-05-timeline-priority-notice` 同时声明 successor），用 `tsx scripts/persistence-changes.ts --update 2026-11-05-timeline-priority-notice --decision same-version` 重算消除。

## 已覆盖，不列为缺口

| 能力 | 本 fork 落点 |
| --- | --- |
| 回合循环、工具调用、流式输出、会话恢复 | `packages/core/pi-agent-loop`、`packages/core/agent-loop` |
| 多提供方模型运行时、目录发现、端点服务路由 | `packages/llm/llm-pi-ai` |
| 压缩（阈值、按模型覆盖、溢出重试、`/compact`） | `packages/compaction/compaction-basic` |
| 压缩摘要换模型、窗口重置为本地卡片 | `compaction-basic` 的 `summarizationProvider/Model` 与 `windowReset` |
| 工具结果裁剪、图像卸载 | `packages/compaction/compaction-tool-result-pruner`、`compaction-image-offload` |
| 工具检索 | `packages/core/tool-search` |
| 技能目录与按需加载 | `packages/skill/*` |
| 子代理 | `packages/subagent/*` |
| 计划模式 | `packages/plan/plan-mode` |
| 逐工具调用自动审查 | `packages/experimental/auto-review`（用当前会话模型） |
| 提示缓存保活 | `packages/experimental/warming` |
| 钩子（阻断、询问、附加上下文、停止） | `packages/experimental/hook-protocol` + `hooks-claude-code`/`hooks-codex` |
| 沙箱模式与升权审批 | `packages/sandbox/*`、`packages/interaction/user-approval` |
| MCP 客户端 | `packages/mcp/*` |
| 会话分叉（复制事件前缀） | `packages/api/session-controller` 的 `fork` |
| 结构化输出 | `packages/subagent/subagent/src/structured.ts` |
| 提问与确认交互 | `packages/interaction/*` |
| SSH 执行 | `packages/ssh/*` |
| 遥测 | `packages/telemetry/otel` |
| JSON Schema 校验 | Ajv（`packages/boot/app-boot/src/config-schema/projector.ts`）+ `packages/typert/*` |
| 插件/预设分发与安装 | `packages/boot/plugin-manager`、`packages/bundle/*`、`packages/preset/*` |
| 进程内 SDK 与远端 API | `packages/sdk/*`、`packages/api/*` |
| 项目资源准入 | `packages/boot/app-boot` 的插件行准入（语义与 pi 的 project trust 不同，但已覆盖"未批准不加载"） |

## 结论：优先级与落点

### 1. 虚拟模型路由（virtual model）

pi 的 `registerVirtualModel` 注册一个可选模型，每次请求由 `route(request, ctx)` 决定物理模型与 thinking level；`request.reason` 区分 `user`/`continuation`/`retry`/`direct`，`previous`/`failed` 提供上一轮物理模型与失败信息。router 可返回 `state`，pi 存进会话分支，随分叉与压缩存活，回复被省略时回退到最后作答的物理模型（`docs/virtual-models.md`，示例 `examples/extensions/jev-router.ts`）。

本 fork 现状：`packages/core/agent-default-model` 只回答"新代理用哪个模型"，`packages/llm/llm/src/route.ts` 是静态 provider/model 路由，没有 per-request 动态选择，也没有 router state。

融入方式：在 `llm` 的 route 解析处增加一层虚拟模型解析，`route()` 的输入取自会话投影（上一轮物理模型、失败信息、请求来源），返回值写进会话投影（router state）。价值是按任务/成本/状态分工，并让分类器参与规划（见第 2 项）。成本中；需先确认 `agent-loop` 的模型解析是否已有 per-request 覆盖入口。

### 2. 非 LLM 模型：分类器与图像

pi-ai 1.5.2 的模型目录含 `chat`、`classifier`、`image` 三类；`models.classify()` 与 `models.generateImages()` 用会话凭据运行分类器与图像模型，分类器支持 choice/score/bool 三种问题并返回置信度（`docs/codemode.md`、`docs/models.md`）。

本 fork 现状：`packages/llm/llm-pi-ai/src/catalog.ts` 的 `servesChat()` 明确只把含 chat 模型的提供方注册为目录路由，README 记明"image-generation 或 classifier 模型单独的提供方不进目录、无登录流程"；`packages/llm/llm/src/types.ts` 没有模型种类字段。

融入方式：让 `llm-pi-ai` 暴露 classifier/image 的目录与一次性调用（独立于 chat 流），供虚拟模型路由、auto-review、codemode 使用。成本中；需定义这类调用的会话记录（模型可见⟺日志）与计价口径。

### 3. codemode 工具注入式沙箱

pi 的 `codemode` 让模型写 JavaScript，脚本在 QuickJS 沙箱里运行，**唯一能力是调用注入的工具与非 LLM 模型**；没有 Node API、文件系统、网络、定时器。脚本支持 `@options`（`max_output_tokens`、`timeout_ms`）、`store`/`load`（跨调用持久化，写成功才落会话）、`searchTools`/`describeTool`/`ALL_TOOLS`（3000 token 预算的工具声明）、worker 限额（默认 2）与输出截断（`docs/codemode.md`）。

本 fork 现状：`packages/ptc-runtime/ptc-runtime-node` 在 Node 里执行 async function body、REPL 语句或 VM Script，文件策略可选，状态按进程/owner 保留；没有"沙箱内只暴露工具"的隔离语义，也没有跨调用的键值存储与工具声明预算。

融入方式：作为 `ptc-runtime` 的一种新 runtime（或独立包），把工具注入与工具发现做成第一语义；`store` 走会话投影，按分支隔离。价值是让模型写脚本并行调工具、先过滤大结果再回模型，减少轮次。成本中高（QuickJS 依赖、沙箱内工具调用的审批与日志路径要重新对齐）。

### 4. 提示模板（prompt templates）

pi 把 Markdown 文件变成 `/` 命令：frontmatter 带 `description` 与 `argument-hint`，正文支持 `$1`、`$@`、`${1:-default}`、`${@:N:L}` 替换，参数按 shell 风格引用（`docs/prompt-templates.md`）。项目级模板需 project trust 才加载。

本 fork 现状：`packages/interaction/commands` 的命令由插件用 `ctx.commands.register()` 注册，没有"声明式 Markdown 模板"这一层；`packages/skill/*` 是指令集，不是可复用提示文本。

融入方式：在 `interaction/commands` 旁增加模板发现与展开（模板文件 → 命令定义，参数替换在提交前完成），或作为 `skill` 的一类资源。成本低；需处理模板内容的信任与参数注入边界。

### 5. 输入事件三态（handled）

pi 的 `input` 事件让扩展先于模型看到用户输入，返回 `continue`（继续）、`transform`（改写后进入模型）、`handled`（扩展自行处理，不产生模型消息）；示例 `input-transform.ts` 用 `?quick` 前缀改写、用 `ping`/`time` 直接应答（`docs/extensions.md` 的 Input Events 一节）。

本 fork 现状：`packages/experimental/hook-protocol` 覆盖提示词阻断、附加上下文、停止；没有"扩展处理后不产生模型消息"这一态。

融入方式：在输入准入处增加三态，`handled` 必须留下人工可见的反馈且不写模型消息。成本中；涉及模型可见⟺日志与 ACP/Web 输入路径的一致性。

### 6. 会话标签 / 书签

pi 的会话条目可有 `LabelEntry`（`setLabel(entryId, label)`），`/bookmark` 给条目打标签，供 `/tree` 导航（`docs/session-format.md`、`examples/extensions/bookmark.ts`）。

本 fork 现状：会话格式无 label 概念，`session-projection` 也没有标签键。

融入方式：作为 log-only 投影或新一代事件承载。成本低-中；若动会话格式需按 [会话格式代际](../concepts/session-format-generations.md) 走一代迁移，优先用投影避免换代。

### 7. Git 检查点与 fork 恢复

pi 示例 `git-checkpoint.ts` 在 `turn_start` 用 `git stash create` 建检查点，`/fork` 时询问是否 `git stash apply` 恢复代码状态，`agent_settled` 后清理。

本 fork 现状：`packages/experimental/worktree` 做隔离 checkout（新建分支、进入目录、归档清理），没有"每回合自动快照 + 分叉时恢复代码"的语义。

融入方式：作为 `experimental/worktree` 的补充或独立实验包，检查点与会话条目绑定。成本中；需处理未提交改动、多仓库与沙箱策略。

### 8. handoff（上下文转移到新会话）

pi 示例 `handoff.ts` 用辅助模型把当前对话提取成自包含提示词（上下文、涉及文件、下一步任务），作为草稿开新会话，而不是压缩（`examples/extensions/handoff.ts`）。

本 fork 现状：`fork` 复制事件前缀，`followup`/`step-summary` 做建议与批次摘要，没有"生成新会话提示词草稿"的命令。

融入方式：新增命令或扩展 `followup`，用辅助模型生成草稿供用户编辑。成本低；需定义辅助调用的会话记录与计价。

## 不融入

- **pi 的 JSONL 树与会话格式**：本 fork 已有 v5 + 世代迁移链，不换存储（[会话格式代际](../concepts/session-format-generations.md)）。
- **分支摘要（branch summarization）**：pi 的 `/tree` 导航 + 放弃分支摘要依赖树结构；本 fork 是线性 surface + 投影，融入需先有树导航，成本高，暂不做。
- **pi-tui**：本 fork 有自己的 CLI 与 Web 客户端，不引入差分渲染 TUI 库。
- **pi-telemetry**：本 fork 的 `telemetry/otel` 已有独立通道与导出器，pi-telemetry 的厂商中立契约不带来增量。
- **pi-schema**：本 fork 用 Ajv + typert，替换不产生收益。
- **pi 的包分发机制**：`boot/plugin-manager` + `bundle`/`preset` 已覆盖安装与共享，只取"提示模板"这一类资源（第 4 项）。
- **pi 的 RPC 子进程模式**：本 fork 的 SDK 是进程内 JSON-RPC，另有 `api` BFF；不需要再引一层子进程协议。
- **pi 的 project trust 机制**：本 fork 是宿主应用，工作区由用户打开，已有插件行准入，语义不同。

## 涉及模块

`packages/llm/llm`（route 解析）、`packages/llm/llm-pi-ai`（classifier/image 目录与调用）、`packages/core/agent-default-model`、`packages/core/agent-loop`（模型解析与输入准入）、`packages/ptc-runtime/*`（codemode runtime）、`packages/interaction/commands`（提示模板）、`packages/experimental/hook-protocol`（输入三态）、`packages/session/session-projection`（router state、store、label）、`packages/experimental/worktree`（git 检查点）、`packages/context/followup`（handoff）。

## 待核验

- `agent-loop` 的模型解析是否已有 per-request 覆盖入口，决定虚拟模型路由的落点与改造成本。
- `ptc-runtime` 是否支持在 await 边界让出并保留沙箱状态，决定 codemode 是新增 runtime 还是扩展现有 runtime。
- `session-projection` 能否承载 router state、codemode store 与标签，并满足固定大小或次线性增长规则。
- 本 fork 的 `interaction/commands` 是否适合作为提示模板的宿主，或应并入 `skill`。
- pi main 是否已把 classifier/image 模型接进默认 provider 目录，决定第 2 项的目录工作量。

## 复发预防

- 判定缺口前先在本 fork 搜同义实现（compaction、tool-search、auto-review、warming、hook-protocol、worktree、followup）。
- 涉及会话格式、模型可见输入或 `agent-loop` 的项单独评估，并补升级指南；其余优先做成插件。
- 结论绑定 pi 1.5.2 安装副本；main 变化时重新核对，不沿用过期结论。

## 关联页面

- [pi 后端（pi-agent-loop）](../entities/pi-backend.md) —— 已接入的 Pi 运行时。
- [llm-pi-ai（pi-ai 适配器与提供方路由）](../entities/llm-pi-ai.md) —— 已接入的 pi-ai 多提供方运行时，第 2 项的落点。
- [会话格式代际（相邻迁移链）](../concepts/session-format-generations.md) —— 第 6 项与树结构项的约束。
- [openai/codex 能力面与可融入清单](codex-capability-comparison.md) —— 同一口径的既有对比页。
- [opencode v2.2.7 能力面与可融入清单](opencode-v2-capability-comparison.md) —— 同一口径的既有对比页。
