---
title: ZCode 能力面与可融入清单
type: query
tags: [对比分析, zcode, 工作流, 权限, 会话控制, 提示快照, 编辑匹配, 分享]
created: 2026-11-13
updated: 2026-11-13
sources: []
status: draft
---

# ZCode 能力面与可融入清单

## 问题

ZCode v3.18.1 源码在 `tmp/zcode`（TS monorepo：CLI Agent、Web/Desktop 客户端、服务端、共享 UI）。对照本 fork 的 `packages/`，找出可直接融入或值得借鉴的能力与落点。

## 判定口径

- 只读两侧源码与文档，未安装依赖、未运行。
- 形态不同：ZCode 是「CLI Agent + 独立 Server + 桌面/Web」三层产品；本 fork 是 Cordis 插件树，会话为 JSONL + 投影。只取能力语义与设计边界。
- 已覆盖项先核实再排除。

## 已覆盖，不列为缺口

| 能力 | 本 fork 落点 |
| --- | --- |
| 脚本编排工作流（agent/parallel/pipeline/phase/log） | `packages/workflow/workflow` 的 `workflow` 工具 |
| 子代理树的消息、中断、等待 | `packages/subagent/tool-subagent-control`（send_message、wait_agent、interrupt_agent） |
| 工具结果裁剪与压缩 | `packages/compaction/compaction-tool-result-pruner`、`compaction-basic` |
| 流式 Markdown 增量渲染 | `ui-primitives` 的 incremental + 尾部修复；按围栏委托 |
| 插件市场与客户端插件 | `packages/client/ui-plugin-market`、`ui-plugin-manager`、Cordis 插件包 |
| 工作区快照与脏状态镜像 | `packages/experimental/worktree`、`deliverables/workspace-changes` |
| 会话导出（ZIP，含子会话与附件） | `packages/session-query/session-log-export`（导入也已实现） |
| 沙箱模式与升权审批 | `packages/sandbox/*` |
| MCP 工具与资源订阅 | `packages/mcp/*` |
| 技能目录与按需加载 | `packages/skill/*` |
| 上下文分节组装 | `agent-loop` 的 runtime-context（整份快照，非增量） |

## 结论：优先级与落点

### 1. 动态工作流的日志化与类型化

ZCode 的 Dynamic Workflow 让主代理写 TypeScript 编排子代理：脚本先过 `tsc` 类型检查，`ask<T>` 合成 JSON schema 约束子代理回答，静态分析生成依赖图，每个调用点 journal 化以支持断点重放与严格流程（`tmp/zcode/docs/dynamic-workflow.md`、`apps/zcode-cli/.../dynamic-workflow-run-*.ts`）。

本 fork 现状：`packages/workflow/workflow` 已支持脚本内 `agent()`/`parallel()`/`pipeline()`/`phase()`，但没有类型检查、结构化提问、依赖图与重放。

融入方式：① 脚本执行前用 TypeScript 编译器做类型检查（放进执行引擎，不改工具面）；② 给 `agent()` 增加第二个参数 `schema`，子代理输出按 schema 校验；③ 按脚本 AST 产出调用依赖图，供并发调度与可视化；④ 记录每次调用结果到会话事件，重放时按序号回放、失败可续跑。成本中。

### 2. 权限模型的四个补强

ZCode 的权限设计有本 fork 待办正缺的四点：

- 工具自带 `alwaysAsk`，模式与钩子都不能抹掉（`core/src/permission/service.ts`）。
- 项目级规则集 `{allow, ask, deny}` 持久化，会话级「本次始终允许」只留内存（`tool/executor/permission-rules.ts`、`permission-rules-persistence.ts`）。
- “完全访问”是独立提交动作：固定目标集合、写 receipt、队列忙时拒绝（`runtime/permission-full-access.ts`）。
- 拒绝时可附反馈给模型，审批回复经 responder 竞速，无应答者默认拒绝（`permission-responder-race.ts`）。

本 fork 现状：只有一次性 `allowed-once` 与预设；待办见 [codex 交接](codex-capability-handoff.md) 待办 1/2。

融入方式：在既有审批服务上补 `alwaysAsk` 标记（工具定义字段）、项目规则集（`storage`）、会话级允许、拒绝反馈；“完全访问”做成显式提交动作而非普通 allow。

### 3. 跨会话控制工具的安全边界

ZCode 让模型 list/read/create/fork/send/wait/interrupt 其它会话，但端口层与模型面用两份 schema：模型只能拿 `sessionId`，可信上下文只能由真实连接构造，模型 JSON 无法伪造；提交前用 `AccessGrant.fence` 再校验；`requestId` 由工具层注入、重试只用 `retryOf`（`packages/session-control/src/contract/*`）。

本 fork 现状：`opencode` 工具面有会话移动、工作树、模型查询；没有跨会话控制；`subagent` 控制只覆盖自己的子代理树。

融入方式：新增会话控制工具包，复用 `api/session-controller` 的 `fork`/`prompt` 能力；模型面 schema 去掉端口专用字段；把“可信上下文”做成只能由宿主构造的类型；每次写操作带 `requestId` 幂等键。成本中。

### 4. 提示快照与 meta_user 动态段

ZCode 把首轮 system 字节持久化为快照，后续请求原样复用（冷恢复、升级后不变，压缩时清除）；动态信息（技能目录、记忆、权限变化）走 `meta_user` 附件而不是改 system；上下文 section 带 `cacheHint: stable|dynamic`，stable 段打 ephemeral `cache_control`（`runtime/helpers/prompt-snapshot.ts`、`core/src/context/builder.ts`）。

本 fork 现状：`system-prompt` 投影会按变化替换系统消息；`runtime-context` 整份快照；没有 system 字节冻结与 `cacheControl` 放置。

融入方式：① 冻结首轮 system 字节，只在压缩或显式重建时更换；② 动态上下文改为 sourced user 消息（已有 `runtime-context` 机制，可复用）；③ 给 section 标 stable/dynamic，llm 适配层据此放缓存断点。与 [codex 交接](codex-capability-handoff.md) 待办 3 同一方向，可合并实施。

### 5. 编辑匹配器

ZCode 的 `Edit` 用 8 级匹配：精确 → 引号归一 → 行号前缀 → 转义 → trim → 缩进弹性 → block anchor 相似度（0.8），任何歧义直接失败不猜（`core/src/tool/edit-matchers.ts`）。

本 fork 现状：`packages/fs/tool-fs/src/edit.ts` 只做唯一字面替换，没有降级匹配。

融入方式：把匹配器做成 `fs-patch` 旁的可复用纯函数包，`edit` 与 `str_replace_editor` 共用；每级命中记录诊断，歧义列表返回给模型。

### 6. 文件回滚与工作区检查点

ZCode 的 fork 可闭包工作区 checkpoint；rewind 用 patch 重放并区分“不安全文件”（`runtime/methods/file-rewind.ts`、`docs/file-summary-safe-rewind.md`）。

本 fork 现状：`deliverables/workspace-changes` 有按轮首尾快照，但没有恢复动作。

融入方式：基于现有快照加“恢复到某轮”，不安全的文件（二进制、超限、被外部修改）不自动恢复并列出原因。与 [opencode 能力对比](opencode-v2-capability-comparison.md) 第 7 项同源。

### 7. 钩子的工作区信任准入

ZCode 的项目级 hooks 需经不可变内容摘要 + 信任准入才生效，且有 7 个事件点；权限事件在审批 UI 之前裁决（`core/src/hooks/*`、`docs/workspace-hook-trust-user-guide.md`）。

本 fork 现状：`experimental/hook-protocol` 直接从配置路径加载项目钩子，没有信任门。

融入方式：给项目级钩子文件加内容摘要，首次启用需用户确认；信任状态存项目级设置；内容变化即失效。这是安全补强，成本低。

### 8. 工具调度的依赖拓扑

ZCode 把工具调用按依赖排序成 `parallelGroups`：只读/`sideEffectScope:none`/`concurrentSafe` 可并行，`destructive` 永不并行；一组失败不跳过后续组（`core/src/tool/scheduler.ts`、`batch-runner.ts`）。

本 fork 现状：只有 `maxParallelToolCalls` 与 `isConcurrencySafe` 二选一，按提交顺序分组。

融入方式：给工具定义增加“写入目标”声明（路径/资源键），调度器据此把无冲突调用并行、有冲突串行；保持现有信号与结果顺序。成本中。

### 9. 压缩的失败熔断与 off-peak 调度

ZCode 的压缩阈值用 provider usage 而非估算、连续失败 3 次熔断；另有 off-peak 任务：模型可创建“低峰时段执行”的任务，运行时换临时模型身份执行后恢复（`core/src/compact/policy.ts`、`tool/handlers/off-peak.ts`）。

本 fork 现状：`compaction-basic` 有阈值与重试，没有熔断计数与用量优先；`schedule` 有定时但无低峰模型切换。

融入方式：压缩记录连续失败并在 3 次后暂停到下一轮；off-peak 作为 `schedule` 的模型覆盖项（临时切换并恢复），不新增调度器。

### 10. 会话分享（按轮）

ZCode 支持框选轮次发布分享链接，权限 `private/public_readonly/public_importable`，以 `productTurnId` 为身份，落地页可唤起客户端导入（`docs/conversation-share-v1.md`、`packages/web-share`）。

本 fork 现状：只有整会话 ZIP 导出与导入，没有分享链接与按轮粒度。

融入方式：新增导出的“按轮子集”产物（复用现有归档格式）与只读渲染页；公开托管属部署选择，先做本地导出/导入闭环与权限字段，避免引入服务端存储。

### 11. 记忆文件式管线

ZCode 用 `MEMORY.md` 索引 + frontmatter 文件记忆；主轮成功后后台 Extraction 写记忆，Dream 合并带锁与 24 小时最小间隔；Recall 用选择器 + manifest，每次会话字符上限 61440（`core/src/memory/*`、`docs/design/v2/memory/README.md`）。

本 fork 现状：`experimental/memory-notes` 只读注入，没有提取/合并/召回选择器。

融入方式：新增写侧插件（后台辅助模型提取 + 合并 + 密钥扫描），读侧沿用 `memory-notes` 并加字符预算与引用；与 [codex 交接](codex-capability-handoff.md) 待办 9 合并实施。

### 12. 客户端与渲染的几个可借点

- **流式只改透明度**：DOM 文本首帧完整，用 rehype 插件逐段改透明度，避免高度逐帧增长破坏虚拟滚动（`packages/ui/src/components/ai-elements/message.tsx`）。本 fork 的增量解析可保留，透明度揭示可作为可选层。
- **turn render unit**：以用户 query 为锚折叠工作段，显示“已工作 N 秒”，手动压缩不出用户气泡（`v4/conversationTurnRenderUnits.ts`）。
- **side pane 多标签 + 侧问**：侧问是独立 child session，右侧复用会话视图（`app-shell/SelectionSideChatPane.tsx`）；本 fork 的侧问待办可参照。
- **帧桶性能工具**：把流式体验量化成每帧字符数与峰值预测（`packages/stream-animate/src/server/frameBuckets.ts`），可做渲染性能门禁。
- **design-runtime**：内置浏览器里点选页面元素改样式并写回源码，带期望内容校验与撤销（`packages/design-runtime/src/CONTRACT.md`）；属新能力，优先级低。
- **formal-proof**：产品状态空间枚举器，穷举上下文 × 动作并产出可评审 trace（`packages/formal-proof/src/model.ts`）；可作为交互回归的补充工具。

### 13. Provider 三层配置与模型选项映射

ZCode 的 provider 配置分 Built-in / Personal / Account Overlay 三层，`resolveEffectiveModelSelection` 只解析未来执行意图，账号事实缺失时 fail-closed 而非静默换供应商；`model-option-map` 用受限 CEL 子集把选项值编译成有序 merge patch（`packages/provider/src/{sources,effective-model-selection}.ts`、`packages/model-option-map/src/compiler.ts`）。

本 fork 现状：`llm` 有 provider 路由与 profile，没有账号层 overlay 与“选项 → 请求体补丁”的声明式映射。

融入方式：先做模型选项映射（配置驱动、按模型缓存编译结果），再加账号层 overlay；fail-closed 语义要写进错误码与 UI。

### 14. 扩展宿主的能力授权

ZCode 的 extension host 是单进程扩展宿主，能力表是唯一定义，表外能力不存在；授权档位成链覆盖，权限变宽后 `consentRevision` 要求重新确认；文档明确“授权用于归因与防误用，不是安全边界”（`packages/shared/src/extension-host/{capabilities,grants}.ts`）。

本 fork 现状：客户端插件走 Cordis 包与市场，没有按插件的能力声明与再确认。

融入方式：给插件清单加能力声明（会话读写、通知、UI 槽位），首次启用与权限变宽时要求确认；不要把它当安全沙箱宣称。

### 15. 安全与诊断的小项

- 一次性短期 host capability ticket 叠在长期 token 之上，消费即删、30 秒 TTL（`packages/server/src/hostCapability.ts`）：可用于远端工作区或外部入口。
- 拒绝并附反馈、审批 responder 竞速：并入第 2 项。
- CUA 的 fail-closed 占位包保持契约稳定（`packages/zcode-cua`）。

## 不融入

- SQLite 会话库与事件表结构：本 fork 的 JSONL + 世代迁移已发布，不换存储。
- VQL 二进制 RPC、六层 Channel 协议：本 fork 的 Typert Gateway 已覆盖同层职责。
- 独立 Extension Host 进程与 MCP App 沙箱：与 Cordis 插件模型冲突，只取能力声明与再确认。
- CUA 占位实现、immutable release/supervisor：后者本 fork 已有构建产物面与启动器方案。
- Electron 桌面壳的更新与凭据实现：本 fork 已有桌面包与更新通道。

## 涉及模块

`packages/workflow/workflow`、`packages/interaction/user-approval`、`packages/api/session-controller`、`packages/core/system-prompt`、`agent-loop/runtime-context`、`packages/fs/*`、`packages/deliverables/*`、`packages/experimental/hook-protocol`、`packages/core/tools`（调度）、`packages/compaction/*`、`packages/schedule`、`packages/session-query/*`、`packages/experimental/memory-notes`、`packages/client/ui-chat`、`packages/llm/*`、`packages/client/ui-plugin-manager`。

## 待核验

- 本 fork `workflow` 执行引擎能否注入 TypeScript 编译器与 journal 回放。
- `system-prompt` 冻结字节与现有 surface 替换语义是否冲突，压缩后如何重建。
- 工具“写入目标”声明的通用表达（路径 vs 资源键）与现有 `isConcurrencySafe` 的关系。
- 分享产物能否直接复用会话归档格式，以及导入时的权限字段落点。

## 复发预防

- 判定缺口前先核对 `workflow`、`tool-subagent-control`、`compaction-tool-result-pruner`、`session-log-export` 的现状。
- 涉及审批与会话控制的项与 [codex 交接](codex-capability-handoff.md) 的待办 1/2/3 合并评审，避免两套规则模型。