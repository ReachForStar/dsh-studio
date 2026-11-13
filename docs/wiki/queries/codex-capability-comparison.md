---
title: openai/codex 能力面与可融入清单
type: query
tags: [对比分析, codex, 执行策略, 代码模式, 世界状态, 多智能体, 记忆, 沙箱]
created: 2026-11-13
updated: 2026-11-13
sources: []
status: draft
---

# openai/codex 能力面与可融入清单

## 问题

codex 源码在 `tmp/codex`（Rust monorepo `codex-rs`，含 CLI、TUI、app-server、SDK）。对照本 fork 的 `packages/`，找出可直接融入或值得借鉴的能力，给出落点、成本与风险。

## 判定口径

- 结论来自两侧源码与文档的实际读取，未编译、未运行。
- 形态不同：codex 是 Rust 单体 + 每线程 rollout JSONL + sqlite 索引；本 fork 是 Cordis 插件树，会话日志为 JSONL + 投影 + 世代迁移。只取能力语义与设计边界。
- 已覆盖项先核实再排除，避免重复。

## 已覆盖，不列为缺口

| 能力 | 本 fork 落点 |
| --- | --- |
| 程序化工具调用 | `packages/ptc-runtime`、`packages/core/tool-executor-ptc`（run_code + 生成 SDK + 子调用限流） |
| 工具检索 | `packages/experimental/tool-search` |
| 技能目录与按需加载 | `packages/skill/*`、`packages/tool-skill` |
| 共享任务板 | `packages/team/agent-team` |
| 计划模式 | `packages/plan/plan-mode` |
| 自动审查 | `packages/experimental/auto-review`（逐工具调用由当前模型评估） |
| 会话分叉与恢复 | `packages/api/session-controller` 的 `fork`、`packages/core/session` 的种子与恢复 |
| 沙箱模式与升权审批 | `packages/sandbox/*`（read-only / workspace-write / danger-full-access） |
| 提示缓存保活 | `packages/experimental/warming` |
| MCP 工具与资源订阅 | `packages/mcp/*` |
| 聊天内 Mermaid | `packages/client/ui-markdown-mermaid` |

## 结论：优先级与落点

### 1. 执行策略（execpolicy）与“批准并追加规则”

codex 用 Starlark 规则文件表达命令前缀：`prefix_rule(pattern=[...], decision, justification)` 与 `host_executable`，解析在 `codex-rs/execpolicy/src/parser.rs`；决策是 `Allow / Prompt / PromptUser / Forbidden`（`decision.rs`），多规则取最严（`policy.rs`）。审批要求由 `core/src/exec_policy.rs:342` 产出 `Skip / NeedsApproval / NeedsHumanApproval / Forbidden`，批准时可生成 `ExecPolicyAmendment` 追加写规则文件（`execpolicy/src/amend.rs`）。

本 fork 现状：审批只有一次性 `allowed-once`，策略只有 `ask` / `never`，没有规则文件与“总是允许”的持久化（`packages/interaction/user-approval`）。

融入方式：把 `execpolicy` 的规则模型移植成 TS 包（纯解析 + 求值 + 最严合并），规则来源放项目配置与用户级文件；审批服务在询问前求值，`Forbidden` 直接拒绝、`Allow` 直接放行、`PromptUser` 不允许自动审查。批准路径增加“并追加规则”，规则写入走 `packages/storage`。这正是待办“权限规则化”最具体的参照（另见 [opencode 权限规则化](opencode-v2-capability-comparison.md) 第 2 项）。

### 2. 审批结果词汇与人工不可绕过

codex 的 `ReviewDecision` 包含 `Approved`、`ApprovedExecpolicyAmendment`、`ApprovedForSession`、`ApprovedMcpPolicyAmendment`、`NetworkPolicyAmendment`、`Denied`、`TimedOut`、`Abort`（`protocol/src/protocol.rs:4571`）；`NeedsHumanApproval` 不能被自动审查或钩子满足（`core/src/tools/approvals.rs`）。

本 fork 现状：`ApprovalOutcome` 只有 `allowed-once | rejected | cancelled | unavailable`。融入方式：扩展结果词汇（会话级允许、规则修订、超时、放弃），并保留 `unavailable` 的 fail-closed；客户端 `ui-approval` 增加对应动作。

### 3. 世界状态的增量注入

codex 把上下文切成独立 section（AGENTS.md、环境、权限、工具、模型说明、协作模式），每节渲染片段带 SHA1 身份，按 RFC 7386 merge patch 只注入变化部分，快照随 rollout 持久化（`core/src/context/world_state/mod.rs:349,431,503`、`core/src/session/world_state.rs`）。

本 fork 现状：`agent-loop/src/runtime-context.ts` 只在整份快照内容不同时重发整份；指令变化只在成功文件操作或恢复时协调。

融入方式：把运行时上下文按来源分节、给每节内容哈希、只发 delta（新增/替换/删除），并持久化已发布快照以避免恢复后整份重发。收益是长会话的提示稳定与缓存复用；风险是与 `系统提示⟺日志` 的重建规则要对齐，需要新的 log-only 事件或复用运行时上下文事件。

### 4. 代码模式的执行协议

codex code mode 用两个模型工具：`exec`（自由文本 JS，可带 pragma）与 `wait`（续取），运行时是真 V8（`code-mode-runtime`，每 cell 新 isolate，microtask 显式泵送），宿主进程经 stdio/gRPC 隔离（`code-mode-host`）；每次 cell 有 yield 时间、堆上限与输出预算；输出截断有 `Client/Server` 两种模式与能力协商（`code-mode-protocol/src/host/mod.rs`）；嵌套工具调用走正常路由器，审批、沙箱、限流逐个生效（`core/src/tools/code_mode/delegate.rs`）。

本 fork 现状：PTC 用 Node/CPython 运行时，`run_code` 一次返回，没有 yield/wait 续取，也没有宿主侧截断协商；嵌套调用已走同一管道。

融入方式：① 给 `ptc-runtime` 增加“可续取”语义（程序在 await 处让出、返回句柄、`wait` 继续）；② 若部署需要执行不可信 JS，再评估 V8 isolate；③ 输出预算协商可先做成宿主配置。成本中高，先做 ①。

### 5. `apply_patch` 自由格式补丁工具

codex 的 `apply-patch` 是自定义补丁语言（`*** Begin Patch`、Add/Delete/Update、`Move to`、`@@` 上下文），带三级匹配降级与 BOM/行尾保留（`apply-patch/src/{parser,file_update,seek_sequence,text_file}.rs`）；模型侧是 freeform 工具，语法随附件注入；shell 里调用 `apply_patch` 会被拦截改走工具路径（`core/src/tools/handlers/unified_exec/exec_command.rs:180`）；安全评估按“目标是否全在可写根内”给出自动批准/询问/拒绝（`core/src/safety.rs`）。

本 fork 现状：`packages/fs/fs-patch` 已有同一套补丁解析与 hunk 应用，但没有模型工具，也没有 shell 拦截；模型侧是 `edit` / `str_replace_editor`。

融入方式：新增 `apply_patch` 工具包（freeform 参数 + 附件文法 + `ctx.fs` 写入），沿用 fs 的 read-before-edit 与沙箱策略；shell 拦截可在 `bash` 前置解析命令并对 `apply_patch` heredoc 走工具路径。成本中。

### 6. 钩子事件面与输入改写

codex 有 14 个钩子事件（PreModelRequest/PostModelRequest、PreToolUse、PermissionRequest、PostToolUse、Pre/PostCompact、SessionStart/End、UserPromptSubmit、SubagentStart/Stop、Stop、Interrupt），`PreToolUse` 可返回 `updated_input` 改写工具参数，`PostToolUse` 可阻断并追加有界上下文，`PermissionRequest` 位于审批之前、deny 优先（`hooks/src/events/*.rs`、`hooks/src/engine/dispatcher.rs`）。

本 fork 现状：`packages/experimental/hook-protocol` 只覆盖提示词与工具调用拦截、附加上下文、停止；没有参数改写、审批前裁决、模型请求/压缩/会话生命周期事件。

融入方式：扩展事件点与决策词汇（先加 `PermissionRequest` 与 `PreToolUse.updated_input`），复用现有命令钩子执行与超时边界；改写后的参数必须进入日志（模型可见⟺日志）。

### 7. 压缩矩阵与保留事实

codex 的压缩有多种入口：本地摘要、远端 V2 检查点、**token-budget 直接开新窗口**（不生成摘要）、后台推测压缩、模型回退重试；并以 `comp_hash` 判断压缩产物是否可被当前模型配置解释（`core/src/compact*.rs`、`protocol/src/openai_models.rs:487`）。另有 `retained_context`：刻意放在摘要契约之外的有界事实，压缩后仍可供审查（`history/src/retained_context.rs`）。

本 fork 现状：`packages/compaction/compaction-basic` 只做“摘要 + 保留近期消息 + 溢出重试”。

融入方式：先加 token-budget 压缩（超限时清空窗口并保留系统提示与近期用户意图），再加压缩模型回退；`retained_context` 可作为新的 log-only 投影供 auto-review 使用。成本中。

### 8. rollout-trace 调试包

codex 的 `rollout-trace` 独立于会话日志记录 `trace.jsonl`、原始请求/响应 payload 与可重放的 reduced 模型，覆盖推理尝试、工具派发、MCP、code cell、压缩检查点（`rollout-trace/src/{lib,bundle}.rs`）。

本 fork 现状：有会话日志、`session-query`、`token-meter` 与 OTEL，但没有“按线程打包原始请求/响应供离线复现”的产物。

融入方式：新增诊断插件，按会话生成可下载 ZIP（原始模型请求/响应、工具调用、压缩点），默认关闭；注意脱敏与体积上限。

### 9. 消息板、代理图与树级预算

codex 的消息板是三段式：`AgentMessageBoard` 接口 / `MessageBoardHost` 能力 / 四种后端（SQLite、内存、HTTP、MCP），权限由后端计算，工具选择不授权（`message-board/src/{api,host,permissions}.rs`）。代理图用 Open/Closed 单向边、广度优先后代查询与空闲驱逐（`agent-graph-store/src/store.rs`、`core/src/agent/control/residency.rs`）。预算按 root 会话树累计加权 token，超限拒绝并提醒（`core/src/rollout_budget.rs`）。

本 fork 现状：`agent-team` 是共享任务板；子代理关系存在会话头，没有消息板、图服务或树级预算。

融入方式：先做树级预算（`token-meter` 已有口径，可加 `rolloutBudget` 配置与提醒）；消息板可基于 `team` 扩展为带频道的异步信箱；图服务在 `session-projection` 里做派生即可。成本中高。

### 10. 记忆写管线

codex 的记忆读写分 crate：写侧在 root 会话启动后后台两阶段提取（单 rollout 并发 + 合并），带租约、失败延后、密钥脱敏；读侧注入 developer 指令、解析引用并统计用量（`memories/write/src/{start,phase1_output}.rs`、`memories/read/src/{lib,citations,usage}.rs`）。

本 fork 现状：`packages/experimental/memory-notes` 只读 `MEMORY.md` 并注入，没有提取、合并、清理（[qwen 对比](qwen-code-capability-comparison.md) 已记同一缺口）。

融入方式：新增写侧插件，后台用辅助模型从会话提取事实，按预算重写 `MEMORY.md`，并做密钥扫描；提取请求不进主会话历史。

### 11. 外部会话与配置迁移

codex 的 `external-agent-migration` 导入 Claude Code / Cursor 的配置、技能、AGENTS.md、插件、MCP、子代理、钩子、命令、记忆与会话（转写记录 + 导入台账去重，`external-agent-migration/src/sessions/{records_cla,records_cur,ledger}.rs`）。

本 fork 现状：`packages/experimental/agent-plugins` 只加载可移植插件包；会话导入尚未实现（[交接页](opencode-capability-handoff.md) 待办 5）。

融入方式：先做会话导入（复用 codex 的“导入台账 + 源格式版本”思路），再做配置迁移；源材料只读，导入后标注 `<EXTERNAL SESSION IMPORTED>`。

### 12. 沙箱网络与拒绝反馈

codex 有网络代理（HTTP/SOCKS5、域名策略、MITM、凭证代理与延迟网络审批：连接挂起等决定，`network-proxy/src/*`、`core/src/tools/network_approval.rs`），沙箱拒绝分类（`sandboxing/src/denial.rs`）与内容完整性检查（`sandboxing/src/sandbox_integrity/*`），另有进程加固（`process-hardening/src/lib.rs`）。

本 fork 现状：`packages/sandbox/*` 是文件访问模式与升权，没有网络代理与拒绝分类。

融入方式：先做拒绝分类与模型可见诊断（成本低），再评估网络策略；“延迟审批”需要挂起连接，属新能力。

### 13. 其他候选（低优先）

- worktree 与线程绑定：codex 用 `<git-dir>/codex-thread.json` 原子绑定线程与检出（`worktree/src/lib.rs`），本 fork 的 worktree 只有脏状态镜像。
- durable sleep 与被消息唤醒：`ext/items/src/sleep.rs` + `core/src/tasks/mod.rs` 的 wake 条件，可补强 `packages/schedule` 的后台自主性。
- 提示缓存键策略：SessionDerived/Custom/Omit 与 TTL（`core/src/thread_manager.rs:333`），可与 warming 配合。
- 关键路径计时：按 sampling/compaction/tool 分类，缺失记 `Incomplete`（`analytics/src/turn_critical_path.rs`）。
- 反馈支持包：日志层缓冲 + rollout 归档 + 连通性诊断（`feedback/src/*`）。
- 技能增量注入与“禁止委派阅读”：`ext/skills/src/world_state.rs`、`catalog_prompt.rs`。

## 不融入

- Rust 运行时与平台沙箱实现（bwrap/seccomp/seatbelt/Windows token/MXC）：形态不同，只取策略与诊断语义。
- Starlark 解释器：规则语法语义可移植，但实现用 TS 即可，不引入 Starlark 运行时。
- sqlite 状态库与 rollout 格式：本 fork 的会话格式已发布并带世代迁移，不换存储。
- V8 UI 插件宿主（窄 ABI、128KB 源码上限）：本 fork 走 Cordis 客户端插件与市场，替换会重做发布链。
- OpenAI 托管后端、chatgpt/cloud-tasks、agent-identity 云注册：与本部署无关。

## 涉及模块

`packages/interaction/user-approval`、`packages/client/ui-approval`、`packages/schedule`、`packages/storage`、`packages/core/agent-loop`（runtime-context）、`packages/context/*`、`packages/ptc-runtime/*`、`packages/core/tool-executor-ptc`、`packages/fs/*`、`packages/shell/*`、`packages/experimental/hook-protocol`、`packages/compaction/*`、`packages/experimental/memory-notes`、`packages/session-query/*`、`packages/sandbox/*`、`packages/experimental/worktree`、`packages/team/*`、`packages/llm/token-meter`。

## 待核验

- `agent-loop` 的运行时上下文是否已有按来源分节的身份信息，决定世界状态增量注入的改造成本。
- PTC 运行时能否在 await 边界让出并保留沙箱状态；Node 版与 CPython 版的差异。
- `fs-patch` 的 hunk 语义与 codex 的三级匹配是否完全等价，决定 `apply_patch` 工具能否直接复用。
- 本 fork 审批服务是否允许在“询问前”求值规则而不改公开契约。
- 会话导入的目标存储语义（种子 vs 普通重放）与 `isSeeded` 标记。

## 复发预防

- 判定缺口前先在本 fork 搜同义实现（ptc、tool-search、team、auto-review、sandbox）。
- 需要改会话格式或 `agent-loop` 的项单独评估并补升级指南；其余优先做成插件。