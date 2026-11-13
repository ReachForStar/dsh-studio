---
title: codex 能力落地交接（12 项）
type: query
tags: [交接, codex, 执行策略, 世界状态, 代码模式, 压缩, 多智能体, 记忆, 沙箱]
created: 2026-11-13
updated: 2026-11-13
sources: []
status: draft
---

# codex 能力落地交接（12 项）

## 一句话结论

[codex 能力面与可融入清单](codex-capability-comparison.md) 已给出 12 项候选。本页是实施交接：每项含现状、参考路径、落地步骤、验收与风险。下一会话按批次推进，不需要重新调研。

## 当前状态（开工前先核对）

- 分支 `develop` 与 `me/develop` 已同步；工作区只有用户自己的 `__pycache__` 未跟踪目录，不要动。
- 已由并行会话完成、**不要重做**：
  - PTC 按预算压缩 SDK 声明：`packages/core/tool-executor-ptc/src/sdk-catalog.ts`（提交 `feat(ptc): 按预算压缩生成的 SDK 声明`）。
  - 会话日志归档导入：`packages/session-query/session-log-export/src/importer.ts`（提交 `feat(session-log-export): 导入会话日志归档`）。
- 并行会话正在实现权限规则（`user-approval`、`tools` 的审批资源契约、`fs` 写工具、`bash`），工作区有未提交改动且当前 `typecheck` 未通过。开工前先 `git status` 与 `git log` 核对：若该项已提交，直接跳过待办 1/2 的重复部分，只补本页列出的验收缺口。
- 其余 opencode 交接项见 [opencode 能力落地交接](opencode-capability-handoff.md)，与本页不重叠。

## 推荐批次与顺序

| 批 | 项 | 原因 |
| --- | --- | --- |
| A | 1 执行策略、2 审批词汇、6 钩子（审批前裁决） | 同一子系统，一次把权限模型补齐；钩子事件面依赖审批词汇 |
| B | 3 世界状态增量注入 | 独立，收益是长会话提示稳定 |
| C | 5 `apply_patch`、4 代码模式续取 | 都能复用现有解析/运行时，互不依赖 |
| D | 7 压缩矩阵 | 依赖 3 的分节上下文更好落地，但可独立 |
| E | 8 多智能体、9 记忆写管线 | 都依赖后台任务与辅助模型调用 |
| F | 10 外部迁移、11 沙箱、12 零散 | 收尾与增强 |

每批完成即跑本批测试与 `pnpm run typecheck`，不要攒到最后。

## 待办 1：执行策略（execpolicy）与“批准并追加规则”

现状：`packages/interaction/user-approval` 只有一次性 `allowed-once`；`packages/interaction/permission-presets` 是预设；没有规则文件。

参考：`tmp/codex/codex-rs/execpolicy/src/{parser,policy,decision,rule,amend}.rs`；审批接线 `core/src/exec_policy.rs:342`；规则文件默认 `~/.codex/rules/default.rules`。

落地步骤：

1. 新建纯函数包 `packages/experimental/exec-policy`（或 `packages/guard/exec-policy`）：规则类型 `{pattern: string[], decision: 'allow'|'prompt'|'prompt-user'|'forbidden', justification?, match?, notMatch?}`，支持命令前缀匹配与多规则“最严优先”。
2. 规则来源：项目级 `.dsh/rules/*.rules` 与用户级 `<dsh home>/rules/*.rules`；解析失败显式报错，不静默跳过。规则语法用 TS 可读的 declarative 文本（不要引入 Starlark 运行时）。
3. 接线：`tools/pre-execute` 之前或审批服务内，用工具名 + 参数提取的命令前缀求值；`forbidden` 直接拒绝并给模型可读原因，`allow` 跳过询问，`prompt-user` 禁止自动审查。
4. 审批路径增加“并追加规则”：批准时根据本次命令前缀生成拟议规则，写规则文件；写入走 `packages/storage` 的既有能力，注意并发与去重。
5. 资源契约：先只覆盖 `bash`/`pwsh` 与 `apply_patch`（可写根）；其他工具按工具名匹配。

验收：规则解析失败报错、最严合并、`forbidden` 不被自动审查放行、追加规则后同前缀直接通过、跨会话规则持久化。

风险：命令前缀提取需要 shell 解析，不要用字符串 `startsWith` 冒充；只允许保守前缀（首个命令 + 子命令）。

## 待办 2：审批结果词汇与人工不可绕过

现状：`ApprovalOutcome` 只有 `allowed-once | rejected | cancelled | unavailable`（`packages/interaction/user-approval/src/types.ts`）。

参考：`tmp/codex/codex-rs/protocol/src/protocol.rs:4571`（`ReviewDecision`）、`core/src/tools/approvals.rs`（`NeedsHumanApproval` 不可被自动审查或钩子满足）。

落地步骤：

1. 扩展结果：`allowed-once | allowed-for-session | allowed-with-rule | rejected | timed-out | cancelled | unavailable`；保持 `unavailable` fail-closed。
2. 会话级允许存进审批服务的会话状态（不写规则文件），会话结束即失效。
3. `NeedsHumanApproval` 成为请求属性；`experimental/auto-review` 与钩子只能返回 allow/deny/弃权，不能替代人工。
4. `packages/client/ui-approval` 增加“本会话允许”“允许并添加规则”两个动作，文案走 typed locale。
5. 超时：请求可选 `timeoutMs`，超时记 `timed-out` 并拒绝执行；审计事件保持一问一答。

验收：自动审查不能放行 `NeedsHumanApproval`、会话级允许跨工具调用生效且会话结束失效、超时审计与模型可见结果一致。

## 待办 3：世界状态的增量注入

现状：`packages/core/agent-loop/src/runtime-context.ts` 比对整份快照后整体重发；没有分节身份。

参考：`tmp/codex/codex-rs/core/src/context/world_state/mod.rs:349,431,503`、`core/src/session/world_state.rs`。

落地步骤：

1. 给运行时上下文的每个来源（指令、环境、权限、工具、模型说明等）产出稳定 section id 与内容哈希。
2. 变化时只发送 delta：新增、替换、删除三类；未变化 section 不进入新消息。
3. 已发布快照随会话事件持久化，恢复后不重发整份；压缩后按需要重投完整快照（沿用现有 `runtime-context` 事件即可，必要时加 log-only 投影）。
4. 保持“模型可见⟺日志”：delta 必须可从事件重建当前完整快照。

验收：两次请求之间改一个 section 只产生该节 delta、恢复后零重发、压缩后完整重投、未知 section 保守处理。

## 待办 4：代码模式续取与限额（预算目录已完成）

现状：`packages/core/tool-executor-ptc` 已有预算目录（`sdk-catalog.ts`）；`run_code` 一次返回，没有 `wait` 续取；`packages/ptc-runtime` 是 Node/CPython 进程。

参考：`tmp/codex/codex-rs/code-mode-protocol/src/{session,runtime}.rs`（yield/wait、限额）、`code-mode-runtime/src/service.rs`（每 cell isolate）、`core/src/tools/code_mode/delegate.rs`（嵌套调用走正常路由）。

落地步骤：

1. 在 `ptc-runtime` 增加“可续取程序”能力：程序在 `await` 边界让出，返回句柄；下一次调用用句柄继续；取消与 dispose 关闭全部句柄。
2. `tool-executor-ptc` 增加对应模型工具（如 `wait`）或在 `run_code` 参数上扩展续取语义；句柄必须不可伪造，绑定 agent/session。
3. 限额：每程序总时长、堆/内存上限、输出字节；超限返回明确失败并清理状态。
4. 输出预算协商：宿主可声明“我负责截断”，客户端不再二次截断；默认由客户端截断即可。

验收：让出后续取结果一致、跨请求句柄不可串用、超限终止且状态清空、取消清理无泄漏。

风险：Node 与 CPython 两个运行时语义不同；先做 Node。

## 待办 5：`apply_patch` 自由格式工具

现状：`packages/fs/fs-patch` 已有 Codex 风格补丁解析与 hunk 应用；模型侧只有 `edit`/`str_replace_editor`。

参考：`tmp/codex/codex-rs/apply-patch/src/{parser,file_update,seek_sequence,text_file}.rs`、`core/src/tools/handlers/apply_patch_spec.rs`、`core/src/safety.rs`。

落地步骤：

1. 新增工具包 `packages/fs/tool-apply-patch`：freeform 文本参数、语法说明随工具说明书下发，产出按 `ctx.fs` 应用。
2. 匹配沿用 `seek_sequence` 的三级降级（精确 → 忽略行尾空白 → 忽略首尾空白），保留 BOM/行尾。
3. 安全：目标必须全在可写根内；否则返回 `ToolArgsError` 或走审批，不允许部分写入。
4. 可选：在 `bash` 前置解析 heredoc，识别 `apply_patch` 调用并改走工具路径（先做提示，不做静默改写）。

验收：多文件补丁、Move、EOF 上下文、行尾/BOM、越界目标拒绝、失败不产生半写文件。

## 待办 6：钩子事件面扩展

现状：`packages/experimental/hook-protocol` 只覆盖提示词与工具拦截、附加上下文、停止；不能改写工具参数，没有审批前裁决。

参考：`tmp/codex/codex-rs/hooks/src/events/*.rs`、`hooks/src/engine/dispatcher.rs`、`protocol/src/hooks.rs`。

落地步骤：

1. 决策词汇：`PreToolUse` 增加 `updatedInput`；新增 `PermissionRequest`（allow/deny/弃权，deny 优先）。
2. 事件点：先加 `PermissionRequest`、`PreModelRequest`、`PostModelRequest`、`PreCompact`、`PostCompact`；会话/子代理生命周期事件可后置。
3. 执行：沿用现有命令钩子超时与并发；同步钩子可阻塞，异步钩子只记录不等待。
4. 边界：钩子改写参数后必须写会话日志（模型可见⟺日志）；`NeedsHumanApproval` 不可被钩子放行。

验收：deny 优先折叠、改写参数生效并进日志、异步钩子不阻塞、超时与失败不杀死回合。

## 待办 7：压缩矩阵与保留事实

现状：`packages/compaction/compaction-basic` 只有摘要 + 保留近期消息 + 溢出重试。

参考：`tmp/codex/codex-rs/core/src/compact.rs`、`compact_token_budget.rs`、`session/async_compaction.rs`、`compact_model_fallback.rs`、`history/src/retained_context.rs`、`protocol/src/openai_models.rs:487`。

落地步骤：

1. token-budget 压缩：超限时不生成摘要，直接开新窗口，保留系统提示、当前目标与最近用户意图；仍触发压缩前后事件。
2. 后台推测压缩：回合空闲时预生成摘要，下一步按需安装；失败不影响当前回合。
3. 模型回退：压缩请求失败时用当前模型重试一次，再失败则走 token-budget。
4. 保留事实：新增 log-only 的 `compaction/retained` 投影，供 auto-review 与审计读取，不进入摘要。
5. `comp_hash` 等价物：记录压缩产物的模型/提示版本，不匹配时拒绝直接复用。

验收：窗口重置、后台压缩安装与丢弃、回退链、保留事实不被摘要吞掉、压缩后工具对配对完整。

## 待办 8：消息板、代理图与树级预算

现状：`packages/team/agent-team` 是共享任务板；没有消息板、图服务或树级预算。

参考：`tmp/codex/codex-rs/message-board/src/{api,host,permissions}.rs`、`agent-graph-store/src/store.rs`、`core/src/agent/control/{residency,budget,interrupt}.rs`、`core/src/rollout_budget.rs`。

落地步骤：

1. 消息板：定义 board 接口 / host 能力 / 后端（本地文件或 sqlite、内存、HTTP、MCP 适配器）；权限由后端计算，工具选择不授权。
2. 代理图：基于会话头与 team 关系派生 Open/Closed 边与后代查询，放 `session-projection`；不要新建全局单例。
3. 树级预算：`token-meter` 口径已经存在，按 root 会话树累计；超限拒绝并给提醒；阈值提醒需可配置。
4. 中断：只允许父对直接子级；未加载目标视为成功但不重载。

验收：跨后端同一契约、权限拒绝结构化、预算跨重启累计、后代查询正确、中断不会重载目标。

## 待办 9：记忆写管线

现状：`packages/experimental/memory-notes` 只读 `MEMORY.md` 并注入，没有提取与合并。

参考：`tmp/codex/codex-rs/memories/write/src/{start,phase1_output}.rs`、`memories/read/src/{lib,citations,usage}.rs`。

落地步骤：

1. 写侧插件：root 会话结束后台提取（辅助模型），先逐会话产出摘要与候选事实，再做一次合并；失败延后重试。
2. 去重与预算：`MEMORY.md` 按字节预算裁剪，重复事实合并，超限整条丢弃。
3. 安全：写入前密钥扫描；提取内容不进入主会话历史。
4. 读侧：注入 `MEMORY.md` 时带来源与引用；记忆用量单独统计。

验收：提取不污染主会话、失败不写入、预算裁剪、密钥命中拒绝、跨会话可召回。

## 待办 10：外部会话与配置迁移（归档导入已完成）

现状：会话日志归档导入已实现（`session-log-export/src/importer.ts`）；没有 Claude Code / Cursor 配置与会话转写。

参考：`tmp/codex/codex-rs/external-agent-migration/src/{lib,model,service}.rs`、`sessions/{records_cla,records_cur,ledger}.rs`。

落地步骤：

1. 先做导入台账（源类型 + 源 id + 目标 id + 时间），重复导入跳过。
2. 会话转写：只映射本仓库已有事件与来源种类；无法表达的消息明确拒绝并列出，不要凭空造事件。
3. 配置迁移：技能目录、`AGENTS.md`、MCP 条目、钩子按现有 `agent-plugins` 与 `mcp-manager` 接缝接入；敏感值不落盘。
4. 导入结果标注来源，用户可见。

验收：同源重复导入幂等、未知来源拒绝、技能与 MCP 生效、敏感值不写日志。

## 待办 11：沙箱网络与拒绝反馈

现状：`packages/sandbox/*` 只有文件访问模式与升权；没有网络代理与拒绝分类。

参考：`tmp/codex/codex-rs/network-proxy/src/*`、`core/src/tools/network_approval.rs`、`sandboxing/src/{denial,violation}.rs`、`sandboxing/src/sandbox_integrity/*`、`process-hardening/src/lib.rs`。

落地步骤：

1. 拒绝分类：从退出码、SIGSYS、错误文本识别沙箱拒绝并给模型可读诊断；误报最小化。
2. 进程加固：按平台设置不可 dump、清环境变量、限制 core dump；失败显式报错。
3. 网络：先做域名 allowlist + 延迟审批（连接挂起等决定），不做 MITM；代理只监听 loopback。
4. 完整性：受保护元数据（`.git` 等）在沙箱前后核对，异常报告给模型。

验收：拒绝分类命中与误报样例、加固失败可见、allowlist 与审批生效、完整性异常可见。

## 待办 12：零散项

- rollout-trace：新增诊断插件，导出 `trace.jsonl` + 原始模型 payload + 可重放 reduced 记录；默认关闭、脱敏、体积上限。
- worktree 与线程绑定：在 `<git-dir>` 写线程绑定文件，创建/删除时原子更新；与 `experimental/worktree` 的脏状态镜像共存。
- 关键路径计时：把 turn 拆成 sampling/tool/compaction 等叶子计时，缺失记 `Incomplete`；接 `token-meter`/OTEL。
- 反馈支持包：日志缓冲 + 会话归档 + 连通性诊断，打包下载；脱敏优先。
- durable sleep：定时/被消息唤醒的后台等待，复用 `schedule`/`jobs`，不要新增第二套调度器。
- 提示缓存键策略：`SessionDerived|Custom|Omit` 与 TTL，配合 `experimental/warming`。
- 技能增量注入与“禁止委派阅读技能正文”：在 `skill` 目录与系统提示里落地。

## 全局约束与验证

- 只暂存具体文件；提交信息 `type(scope): 摘要`；推送 `me/develop`。
- 每批最小验证：`pnpm run typecheck`、受影响包 `pnpm exec vitest run <paths>`、`pnpm run build:artifacts && pnpm run build:check`、`pnpm run test:docs`。
- 新包按 `packages/AGENTS.md` 接线：`tsconfig.base.json` paths、`tsconfig.host.json`/`tsconfig.client.json` references、README（Model Experience + 已知限制）、双语配对。
- 会改变模型可见行为的项补 Agent Note；改会话格式的项补升级指南。
- 不要改用户未提交的改动；发现工作区有他人改动时先读再动。

## 参考页面

- [codex 能力面与可融入清单](codex-capability-comparison.md)
- [opencode 能力落地交接](opencode-capability-handoff.md)
- [循环与工具行为决策](../../../.agents/notes/implemented/feature/2026-11-12-opencode-core-behaviors.md)