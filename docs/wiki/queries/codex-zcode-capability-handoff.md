---
title: codex 与 ZCode 能力落地交接（合并版）
type: query
tags: [交接, codex, zcode, 权限, 上下文, 编辑, 钩子, 压缩, 工作流, 多智能体, 记忆, 沙箱]
created: 2026-11-13
updated: 2026-11-14
sources: []
status: draft
---

# codex 与 ZCode 能力落地交接（合并版）

## 结论

本页合并两份分析的可执行部分：[codex 能力面](codex-capability-comparison.md) 与 [ZCode 能力面](zcode-capability-comparison.md)。重复主题已合并（权限、上下文、压缩、钩子、记忆、文件编辑、多智能体），每项只保留一个落点。[codex 单项交接](codex-capability-handoff.md) 已被本页取代。

## 开工前先核对

- 分支 `develop` 与 `me/develop` 同步；工作区可能有并行会话的未提交改动（当前为 `mcp-manager` 接线、`web-app` bundle、`tsconfig`），不要触碰，先 `git status`、`git log` 核对。
- **已完成、不要重做**（含并行会话已提交的）：
  - 审批：按动作/资源规则求值、按项目保存允许规则与“始终允许”、拒绝时改写参数并回传模型、PTC 程序内 `tools.*` 静态扫描。
  - 会话：日志归档导入；侧问面板（btw，child session）。
  - MCP：共享连接池与远程 OAuth。
  - PTC：按预算压缩 SDK 声明。
- 已完成项的文件：`packages/interaction/user-approval/src/rules.ts`、`packages/client/ui-approval`、`packages/core/tool-executor-ptc/src/scan.ts`、`packages/interaction/btw`、`packages/mcp/mcp-client/src/{pool,oauth*}.ts`、`packages/session-query/session-log-export/src/importer.ts`。

## 统一优先级

| 优先 | 合并后的能力 | 来源 | 落点 |
| --- | --- | --- | --- |
| 1 | 审批收尾：命令前缀策略、人工专属、完全访问凭证、会话级允许、规则追加 | codex + zcode | `user-approval`、`ui-approval` |
| 2 | 上下文缓存稳定：世界状态增量、system 字节冻结、meta_user 动态段、缓存断点 | codex + zcode | `agent-loop/runtime-context`、`system-prompt`、`llm` |
| 3 | 文件面：编辑降级匹配、`apply_patch` 工具、文件回滚与不安全分类 | codex + zcode | `fs-patch`、`tool-fs`、`deliverables` |
| 4 | 钩子：事件面扩展与工作区信任准入 | codex + zcode | `experimental/hook-protocol` |
| 5 | 压缩：窗口重置、后台推测、模型回退、失败熔断、低峰调度 | codex + zcode | `compaction/*`、`schedule` |
| 6 | 动态工作流：类型检查、结构化提问、依赖图、journal 重放 | zcode | `workflow/workflow` |
| 7 | 多会话协作：跨会话控制工具、消息板、代理图、树级预算 | zcode + codex | 新工具包、`team`、`session-projection`、`token-meter` |
| 8 | 记忆写管线：会话提取、合并锁与间隔、召回选择器与预算 | codex + zcode | `experimental/memory-notes` 旁 |
| 9 | 迁移与分享：外部配置/会话迁移、按轮分享与导入 | codex + zcode | `session-log-export`、`boot/agent-plugins` |
| 10 | 沙箱增强：网络代理与延迟审批、拒绝分类、完整性检查、进程加固 | codex | `sandbox/*` |
| 11 | Provider 与扩展：三层配置、模型选项映射、插件能力授权与再确认 | zcode | `llm/*`、`ui-plugin-manager` |
| 12 | 诊断与实验：rollout-trace、帧桶性能、关键路径计时、design-runtime、formal-proof | codex + zcode | 各自独立包 |

## 推荐批次

| 批 | 项 | 说明 |
| --- | --- | --- |
| A | 1 | 审批规则已落地，收尾成本最低，先做 |
| B | 2 | 与 A 独立；缓存稳定性收益最大 |
| C | 3 | 文件面三项可共用匹配器与快照 |
| D | 4 | 钩子信任是安全补强，独立 |
| E | 5 | 依赖 B 的分节上下文更顺，但可独立 |
| F | 6 + 7 | 工作流与多会话协作共享子代理与预算 |
| G | 8 + 9 | 记忆与迁移都涉及后台提取与导入台账 |
| H | 10 + 11 + 12 | 增强与收尾 |

每批完成即跑本批测试与 `pnpm run typecheck`，不要攒到最后。

## 1. 审批收尾

已完成：动作/资源规则求值、项目级允许持久化、拒绝时改写参数回传、静态扫描。

剩余：

1. **命令前缀策略**：参考 `tmp/codex/codex-rs/execpolicy/src/{parser,policy,amend}.rs`。用 TS 实现保守前缀匹配（首个命令 + 子命令），规则来源项目与用户级；批准时“追加规则”写规则文件。
2. **人工专属**：请求属性 `needsHuman`；自动审查与钩子只能 allow/deny/弃权，不能替代人工。参考 `core/src/tools/approvals.rs`。
3. **完全访问凭证**：独立提交动作（固定目标集合、写 receipt、忙时拒绝），不当作普通 allow。参考 ZCode `runtime/permission-full-access.ts`。
4. **会话级允许**：仅内存、会话结束失效；与项目规则区分。
5. **结果词汇**：`timed-out`、`abort`、规则修订、网络策略修订。参考 `ReviewDecision`。

验收：前缀规则不误伤（`git status` vs `git push`）、人工专属无法被自动放行、完全访问需显式确认、会话允许不落盘、规则追加后同前缀直接通过。

## 2. 上下文缓存稳定

参考：codex `core/src/context/world_state/mod.rs`（section 哈希 + RFC 7386 merge patch + 快照持久化）；ZCode `runtime/helpers/prompt-snapshot.ts`（冻结首轮 system 字节）、`core/src/context/builder.ts`（`meta_user` 动态段、`cacheHint`）。

步骤：

1. 运行时上下文按来源分节，每节稳定 id + 内容哈希；变化只发 delta（新增/替换/删除）。
2. 已发布快照随会话事件持久化，恢复后不重发；压缩后完整重投。
3. 冻结首轮 system 字节，动态信息改走 sourced user 消息；只有压缩或显式重建才换 system。
4. 给 section 标 stable/dynamic，`llm` 适配层据此放缓存断点（与 `experimental/warming` 配合）。

验收：改一节只发该节 delta、恢复零重发、压缩后完整重投、缓存断点位置可观测。

## 3. 文件面

### 3.1 编辑降级匹配

参考 ZCode `core/src/tool/edit-matchers.ts`：精确 → 引号归一 → 行号前缀 → 转义 → trim → 缩进弹性 → block anchor（0.8）。落点：`packages/fs/fs-patch` 旁纯函数包，`edit` 与 `str_replace_editor` 共用；歧义返回候选列表而不是猜。

### 3.2 `apply_patch` 工具

参考 codex `apply-patch/src/*` 与 `core/src/tools/handlers/apply_patch_spec.rs`。复用现有 `fs-patch` 解析，新增 freeform 工具包，沿用读后写与沙箱边界；可选 shell 拦截。

### 3.3 文件回滚

参考 ZCode `runtime/methods/file-rewind.ts` 与 codex 的 fork 快照。基于 `deliverables/workspace-changes` 现有按轮快照加“恢复到某轮”，不安全文件（二进制、超限、被外部修改）不自动恢复并列出原因。

验收：多级匹配命中与歧义、补丁多文件/Move/EOF、回滚列出跳过项且不半写。

## 4. 钩子

参考：codex 14 个事件与 `PreToolUse.updated_input`、`PermissionRequest`（deny 优先）；ZCode 项目钩子的内容摘要 + 信任准入 + 权限变宽再确认。

步骤：

1. 新增事件：`PermissionRequest`（审批前裁决）、`PreToolUse.updated_input`、`PreModelRequest`/`PostModelRequest`、`PreCompact`/`PostCompact`。
2. 项目级钩子文件加内容摘要，首次启用需确认；内容变更即失效；信任状态存项目设置。
3. 钩子改写参数必须进入会话日志；`needsHuman` 请求不可被钩子放行。

验收：deny 优先、改写进日志、异步钩子不阻塞、摘要变更后拒绝执行、信任确认可撤销。

## 5. 压缩

参考：codex `compact*.rs`（token-budget 新窗口、后台推测、模型回退、`comp_hash`、retained context）；ZCode `core/src/compact/policy.ts`（usage 优先、连续失败 3 次熔断）、`tool/handlers/off-peak.ts`（低峰执行并恢复模型身份）。

步骤：

1. token-budget 压缩：超限直接开新窗口，保留系统提示、当前目标与最近意图。
2. 后台推测压缩与模型回退；失败链最后落到 token-budget。
3. 连续失败计数与暂停；压缩后清除 prompt 快照。
4. off-peak 作为 `schedule` 的模型覆盖项，不新增调度器。
5. retained context 作为 log-only 投影供审查。

验收：窗口重置、后台安装/丢弃、回退链、熔断、压缩后工具配对完整。

## 6. 动态工作流

参考 ZCode `docs/dynamic-workflow.md` 与 `dynamic-workflow-run-*.ts`。本 fork 已有 `workflow` 工具（`agent/parallel/pipeline/phase/log`）。

补：① 执行前 `tsc` 类型检查脚本；② `agent()` 第二参数 schema，按 schema 校验子代理输出；③ 从脚本 AST 产依赖图供调度与展示；④ 每调用点 journal 化，按序号重放、失败可续跑。执行引擎内实现，不改工具面。

验收：类型错误拒绝执行、schema 不符报错、依赖图与实际调用一致、中断后重放结果一致。

## 7. 多会话协作

两部分：

1. **跨会话控制**（ZCode）：新增工具包，模型只能拿 `sessionId`，可信上下文只能由宿主构造；写操作带 `requestId`，重试只用 `retryOf`；提交前 `AccessGrant.fence` 复核。落点 `api/session-controller` 的 `fork`/`prompt`。
2. **消息板 + 代理图 + 树预算**（codex）：消息板三段式（接口/宿主/多后端）与后端算权限；代理图用 Open/Closed 边做后代查询，放 `session-projection`；树级预算接 `token-meter`。

验收：模型无法伪造会话引用、幂等重试、权限拒绝结构化、跨后端同一契约、预算跨重启累计、中断不重载目标。

## 8. 记忆写管线

参考：codex 写侧两阶段提取 + 租约 + 合并；ZCode 文件式 `MEMORY.md` + 后台 Extraction + Dream 合并锁与 24h 间隔 + Recall 选择器与字符上限。

步骤：会话结束后台提取（辅助模型）→ 摘要与候选事实 → 合并去重 → 预算裁剪 → 密钥扫描；读侧沿用 `memory-notes`，加引用与字符预算；提取不进入主会话历史。

验收：提取不污染主会话、失败不写、预算裁剪、密钥命中拒绝、跨会话召回。

## 9. 迁移与分享

1. **外部迁移**（codex）：导入台账（源类型 + 源 id + 目标 id），会话转写只映射已有事件与来源种类，未知来源拒绝；配置迁移接 `agent-plugins` 与 `mcp-manager`。归档导入已完成，不要重复。
2. **按轮分享**（ZCode）：从会话导出“按轮子集”产物与只读渲染页，权限 `private/public_readonly/public_importable`，以轮次 id 为身份；公开托管属部署选择，先做本地导入闭环。

验收：重复导入幂等、未知来源拒绝、分享子集可导入且不泄漏他轮内容。

## 10. 沙箱增强

参考 codex `network-proxy/src/*`、`tools/network_approval.rs`（延迟审批）、`sandboxing/src/{denial,violation}.rs`、`sandbox_integrity/*`、`process-hardening/src/lib.rs`。

步骤：① 拒绝分类与模型可读诊断；② 进程加固（失败显式报错）；③ 域名 allowlist + 延迟网络审批，代理只听 loopback；④ 受保护元数据沙箱前后核对。

验收：拒绝样例与误报样例、加固失败可见、allowlist 与审批生效、完整性异常可见。

## 11. Provider 与扩展授权

1. **Provider 三层配置**（ZCode）：内置 / 个人 / 账号 overlay；账号事实缺失 fail-closed；`model-option-map` 用受限表达式编译成有序请求体 merge patch，按模型缓存。
2. **插件能力授权**：清单声明能力（会话读写、通知、UI 槽位），首次启用与权限变宽再确认；明确“授权用于归因与防误用，不是安全边界”。

验收：overlay 合并顺序、缺账号事实不静默换供应商、选项映射编译确定、权限变宽触发再确认。

## 12. 诊断与实验

- rollout-trace（codex）：导出 `trace.jsonl` + 原始模型 payload + 可重放 reduced 记录，默认关闭、脱敏、体积上限。
- 关键路径计时（codex）：sampling/tool/compaction 分类，缺失记 `Incomplete`。
- 帧桶性能（ZCode）：按 60/120 FPS 统计每帧字符数与峰值，做渲染门禁。
- 流式只改透明度与 turn render unit（ZCode）：可选渲染层，保留现有增量解析。
- design-runtime（ZCode）：浏览器内点选改样式并写回源码，带期望内容校验；优先级低。
- formal-proof（ZCode）：产品状态空间枚举，作交互回归补充。
- 一次性 host capability ticket（ZCode）：短期、消费即删，用于远端入口。
- durable sleep（codex）：复用 `schedule`/`jobs`，不新增调度器。

## 全局约束与验证

- 只暂存具体文件；提交 `type(scope): 摘要`；推送 `me/develop`。
- 每批：`pnpm run typecheck`、受影响包 `pnpm exec vitest run <paths>`、`pnpm run build:artifacts && pnpm run build:check`、`pnpm run test:docs`。
- 新包按 `packages/AGENTS.md` 接线（paths、references、README、双语配对）；改模型可见行为补 Agent Note；改会话格式补升级指南。
- 不要改并行会话的未提交改动；发现工作区变化先读再动。

## 2026-11-13 落地进展

本批先做批次 A 中不依赖钩子与沙箱改动的三项，并同步清偿 hygiene 的四项 fork 债务。

已完成：

1. **命令前缀策略（A1）**：`user-approval` 新增 `match: 'glob' | 'prefix'` 规则模式与纯函数 `commandPrefixOf`、`matchCommandPrefix`、`splitCommandWords`。前缀规则按完整命令词比较，`git status` 放行 `git status -s`，不放行 `git push`、`git statuspage` 或用 `&&` 拼接的第二条命令；引号与转义会识别，控制运算符、重定向、命令替换、子 shell 与展开使命令不参与前缀匹配。`/allow --prefix bash git status` 追加前缀规则。
2. **人工专属（A2）**：`ApprovalRequest.needsHuman` 已落地；规则不能自动放行这类请求（`deny` 仍生效），自动应答者需 `next()` 委托。沙箱升权请求已标记 `needsHuman: true`。
3. **会话级允许（A4）**：`ApprovalService` 以 `WeakMap<Session, ApprovalRule[]>` 保存 `--session` 规则，求值排在项目规则之后，会话结束即丢弃，不写存储域。`/allow --session [--prefix] <action> <resource> [effect]`、`--session list`、`--session remove <n>` 已接线。
4. **门禁债务**：四个 fork 债务门禁已清偿，做法见 [fork 自研包的门禁红项清单](fork-gate-debt.md#2026-11-13-hygiene-四项-fork-债务清偿)。
5. **结果词汇（A5 部分）**：新增 `timed-out`；`ApprovalService` 配置 `timeoutMs`，超时后结算 `timed-out` 并丢弃迟到回答。工具管道新增 `APPROVAL_TIMED_OUT`，沙箱升权新增 `SANDBOX_ESCALATION_TIMED_OUT`，统计面板补 8 语言文案。`abort` 继续由 `cancelled` 表达；规则修订与网络策略修订尚未落地。
6. **编辑降级匹配（C1）**：`applyLiteralEdit` 在精确匹配失败后依次尝试引号归一、复制的行号前缀、转义、trim、缩进弹性与块锚点（行相似度 0.8）；多个候选仍报 `FS_AMBIGUOUS_EDIT` 并给出候选行号。`edit` 与 `str_replace_editor` 共用同一条接缝。`apply_patch` 工具（C2）已存在，本轮未重做。
7. **文件回滚（C3）**：`ctx.workspaceChanges.rewind(sessionId, turn, signal)` 与 `/rewind <turn>` 先预检全部列出文件，当前文本不等于轮次结束侧、二进制、超限或缺少内容来源的文件保持不动并报告原因；预检通过后写回轮次开始文本或删除该轮新建文件。
8. **压缩熔断与回退（E 部分）**：`compaction-basic` 新增 `failurePauseThreshold`（默认 3，`0` 关闭），连续 pre-step 压缩失败达到阈值后暂停自动压力；新增 `summarizationFallback`（默认开启），配置的摘要模型失败时改用会话路由模型重试。窗口重置、后台推测、低峰调度与 retained context 仍未实现。
9. **审批前与压缩钩子（D 部分）**：新增 `tools/permission-request` waterfall，审批接缝在询问应答者之前分发；监听器只能 deny 或委托，不能授予，因此规则、人工专属请求与失败关闭继续生效。Claude Code 桥接新增 `PermissionRequest`、`PreCompact`、`PostCompact` 事件映射；后两者只观测 `compaction/start` 与 `compaction/end`。
10. **记忆写入（G 部分）**：`memory-notes` 新增 `memory_write` 工具，可把一条事实写入项目或用户 `MEMORY.md`。写入按文件串行、拒绝疑似凭据、受 `maxWriteChars` 约束；读侧仍由每步 pre-step 重读。后台轮次提取、合并锁与召回选择器仍未实现。
11. **上下文缓存稳定（B）**：运行时上下文首份快照提交后，变化集合只发送变化/新增节文本与被移除节名称，未变化的节不重复；恢复、旧格式与压缩后重述完整集合；仅顺序变化不产生消息。系统提示词仍按现有投影只在内容变化时追加，避免改写已缓存前缀。显式缓存断点位置（provider cache_control）沿用各适配器已有能力，未新增统一配置。
12. **域名允许清单（H 部分）**：`web-fetch-http` 新增 `allowedHosts` / `blockedHosts`，对请求 URL 与每个同源重定向校验；阻止规则优先，允许清单为空表示不限制。代理、延迟网络审批、Provider 三层配置与诊断实验仍未实现。

## 2026-11-14 A3 完全访问凭证

把「完全访问」做成审批提示上的独立提交动作，不是一条 allow 规则。

1. **提交与回执归 `user-approval`**：`request()` 生成并以 `requestId` 交给应答者，注册执行器时分发的请求带 `fullAccess: true`。`registerFullAccess(handler)` 是唯一执行器注册点；`requestFullAccess(agent, requestId)` 要求该提示仍在等待（否则 `FULL_ACCESS_STALE`），同一会话已有提交在结算时拒绝（`FULL_ACCESS_BUSY`），没有执行器时失败（`FULL_ACCESS_UNAVAILABLE`）。首次提交追加 `approval/full-access` 回执，记录当时仍在排队的输入身份；同一请求重试复用回执，首次提交之后排队的输入不进入授权。执行器在回执之后运行，失败留下可用相同目标重试的授权。
2. **策略应用归 `permission-presets`**：服务注册唯一执行器，通过与 `/permission` 相同的写入路径应用 `fullAccessPreset`（默认 `danger-full-access`）。显式配置未知预设加载即失败；替换表缺少内置默认项只是撤下该动作。新增 `/full-access <requestId>` 命令。
3. **客户端**：`PendingApproval` 携带 `requestId` 与 `fullAccess`；卡片只在两者齐备时显示「完全访问」，先打开风险确认，勾选后通过 `/full-access <requestId>` 提交再回答提示；命令失败时提示保持打开。8 种语言补齐文案。
4. **持久化**：新增仅日志事件 `approval/full-access`，`SESSION_FORMAT_VERSION` 不变（旧读取方拒绝未知必需事件，不会把缺失授权当成未授权）；已补 `docs/persistence-changes/2026-11-14-approval-full-access.md`、生成目录与已知事件清单。
5. **决策记录**：[完全访问提交 Agent Note](../../../.agents/notes/implemented/architecture/2026-11-14-approval-full-access-commit.md)。

验证：`pnpm exec vitest run packages/interaction/user-approval/tests packages/interaction/permission-presets/tests packages/client/ui-approval/tests`（174 项）、`pnpm run typecheck`、`pnpm run test:docs`、`pnpm run verify-persistence-catalog`、`pnpm run verify-persistence-changes`、`pnpm run verify-type-equiv`、`pnpm run verify-cordis-catalog`、`pnpm run verify-config-catalog`、`pnpm run verify-doc-graphs`。

## 2026-11-14 D 项目级钩子信任

1. **发现与准入**：`hooks-claude-code` 在每个钩子点检查会话工作目录下的 `projectHooksPath`（默认 `.claude/settings.json`）；文件原始字节的 SHA-256 摘要只有在存储域为该目录保存同一摘要时才启用项目级分组。未受信任时每个内容版本记录一条警告并跳过，进程级 `configPath` 不受影响。
2. **确认与撤回**：新增 `/hooks status|trust|revoke`。`trust` 记录当前摘要，`revoke` 删除记录；没有存储域时项目级钩子从不运行（缺失即拒绝）。
3. **变更失效**：解析结果按路径与 `mtime`/`size` 戳缓存，文件任一字节变化都会在下一个钩子点暂停执行，直到重新批准。
4. **决策记录**：[项目级钩子信任 Agent Note](../../../.agents/notes/implemented/architecture/2026-11-14-project-hook-trust.md)。

验证：`pnpm exec vitest run packages/experimental/hooks-claude-code/tests packages/experimental/hooks-codex/tests`（134 项）、`pnpm run typecheck`、`pnpm run lint`（受影响文件）、`pnpm run test:docs`。

## 2026-11-14 D 模型请求观测点

1. **新增事件**：`hooks-claude-code` 支持 `PreModelRequest` 与 `PostModelRequest`，分别挂在 `request/header` 与 `assistant/message` 的 durable 标记旁；载荷给出 `provider` 与 `model`，只观测，拒绝只记录。这两个事件属于 harness 扩展点，Claude Code 没有对应事件。
2. **配置面**：解析器接受这两个事件名；无匹配器语义（`''` 查询）。
3. **验证**：`packages/experimental/hooks-claude-code/tests/model-hooks.spec.ts` 与包内 72 项测试。

仍未开始：D 的 `updated_input`、F、H 的其余部分（代理与延迟审批、Provider 三层配置、诊断实验），以及 E 的后台推测/低峰调度/retained context、G 的后台提取。A2 的自动应答者拦截依赖批次 D 的钩子面；当前以请求标志、规则不可放行与文档约定落地。

## 参考页面

- [codex 能力面与可融入清单](codex-capability-comparison.md)
- [ZCode 能力面与可融入清单](zcode-capability-comparison.md)
- [opencode 能力落地交接](opencode-capability-handoff.md)
- [循环与工具行为决策](../../../.agents/notes/implemented/feature/2026-11-12-opencode-core-behaviors.md)