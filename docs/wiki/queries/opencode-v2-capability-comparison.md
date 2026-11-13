---
title: opencode v2.2.7 能力面与可融入清单
type: query
tags: [对比分析, opencode, 能力缺口, 权限规则, 缓存保活, MCP, 卡带录制, 持久终端, 代码模式]
created: 2026-11-12
updated: 2026-11-12
sources: []
status: draft
---

# opencode v2.2.7 能力面与可融入清单

## 问题

opencode 源码在 `tmp/opencode`（`@opencode/cli` 2.2.7，Effect + Bun + Solid 的单体 monorepo，含 TUI、Desktop、Web）。对照本 fork 的 `packages/` 现状，找出可直接融入或值得借鉴的能力，并给出落点、成本与风险。

## 判定口径

- 结论来自两侧源码与文档的实际读取，未编译、未运行任何一方。
- 本 fork 已具备的能力先核实再排除，避免把已覆盖项当缺口。
- 形态不同：opencode 以 Effect 服务图组织 monolithic core，本 fork 是 Cordis 插件树，持久化走 JSONL + 投影 + 世代迁移。只取能力语义，不照搬代码组织。
- 插件化判定沿用[合并上游 2026-11-08](upstream-merge-2026-11-08.md#第-3-项插件化分类)：只依赖已发布公开接缝、不改 harness 源码的算可插件化。

## 实施结果（2026-11-12）

| 项 | 状态 | 落点 |
| --- | --- | --- |
| 提示缓存保活 | 已实现 | `packages/experimental/warming`：重放派生历史、工具声明与路由后追加保活提示；`auto` 间隔因无 TTL 元数据固定 4 分钟 |
| 权限规则化 | 未实现 | 需要先给工具定义确定审批资源契约；现有预设与一次性审批不动 |
| HTTP 卡带录制回放 | 已实现 | `packages/test-support/http-cassette`：录制/回放/auto、顺序匹配、脱敏与 CI 拒绝 |
| MCP OAuth 与池化 | 未实现 | 待确认 MCP SDK 是否提供 OAuth provider |
| 代码模式按需目录与静态扫描 | 未实现 | 目录模式需要运行时支持按需绑定；静态扫描缺少消费方 |
| OpenAPI 转工具 | 已实现 | `packages/experimental/openapi-tools`：operation 转工具、参数合并、主机侧凭据 |
| 侧问面板 | 未实现 | 需要新的客户端面板与 fork 子会话交互 |
| 流式尾部修复 | 已实现 | `ui-primitives` 的 `heal.ts`，追加闭合标记，冻结块不受影响 |
| 聊天内 Mermaid | 已实现 | `packages/client/ui-markdown-mermaid`，注册 `conversation.chat.markdown.fence` |
| 输出上限续跑 | 已实现 | `agent-loop` 的 `maxOutputContinuations`（默认 0） |
| fork 说明注入 | 已实现 | `packages/experimental/fork-notice` |
| 工具输入修复 | 已实现 | `defineTool` 校验前 `repairArgs`，只做唯一确定转换 |
| MCP 事件订阅 | 已实现 | `mcp-resources` 的 `watch_mcp_resource` 与 `mcp-client` 的订阅生命周期 |
| 会话导入 | 未实现 | 需要与导出归档、格式校验和会话准入一起设计 |
| 按轮 Web 来源面板 | 已实现 | `ui-chat` 的 `turn-sources` 节点，聚合搜索与抓取结果 |

实现取舍与默认值记录在 [循环与工具行为](../../../.agents/notes/implemented/feature/2026-11-12-opencode-core-behaviors.md)。

## 已覆盖，不列为缺口

| 能力 | 本 fork 落点 |
| --- | --- |
| 代码模式执行（`run_code` + 生成 SDK + 子调用限流） | `packages/core/tool-executor-ptc`、`packages/ptc-runtime` |
| 流式 Markdown 增量解析（块级冻结、mdast） | `packages/client/ui-primitives/src/markdown/incremental.ts` |
| 工具检索 `tool_search` | `packages/core/tool-search` |
| 工作树快照、Arena、推测执行、步骤摘要、下一步建议 | `packages/experimental/{worktree,arena,speculation,step-summary,followup}` |
| 后台作业、定时任务、目标、子代理 | `packages/{jobs,schedule,goal,subagent}` |
| 会话 ZIP 导出（含子会话与附件） | `packages/session-query/session-log-export` |
| 按轮文件变更快照与差异卡 | `packages/deliverables/workspace-changes` |
| MCP 资源读取、断线重试、凭据模板 | `packages/mcp/mcp-resources`、`packages/mcp/mcp-client` |
| 客户端插件面（槽位、命令、设置页、围栏委托、主题、插件市场） | `packages/client/modules`、`ui-slots`、`ui-primitives`、`ui-plugin-market` |
| 逐轮 effort 变更 | `packages/core/agent-loop` 的 request-reconstruction 测试已覆盖 |
| 上下文逐项成本 | `packages/llm/token-meter` 的 `contextBreakdown` |

## 结论：优先级与落点

### 1. 提示缓存保活（warming）

opencode 的 `packages/core/src/plugin/warming.ts` 与 `packages/schema/src/config/warming.ts`：活跃请求结束后按缓存 TTL 定时发最小 keep-alive 请求。`interval: "auto"` 取模型 `cache.ttl` 的 90%，没有 TTL 时为 4 分钟；`duration` 默认 30 分钟；顶层 `warming` 与模型 `cache.warming` 都没开时判为 `Off`，缓存寿命超过窗口时判为 `CacheOutlivesWindow` 而不发请求。

本 fork 现状：没有 keep-alive（全仓 `cache warm`、`keep-alive` 无命中），`packages/llm/llm-pi-ai` 只把 `cacheRetention` 透传给 profile。

融入方式：新增 llm 侧插件，在步骤边界后按模型缓存 TTL 调度最小请求；计费与「无 TTL 不启」的判定要先落实 provider 元数据。属插件级，不改核心。

### 2. 权限规则化、持久规则与参数纠正

opencode 的 `packages/schema/src/permission.ts` 用 `{action, resource, effect: allow|deny|ask}` 加通配符表达规则，后写优先，`evaluate`/`merge` 是纯函数；`packages/core/src/permission/saved.ts` 按项目持久化 allow 规则（list/add/update/remove + 冲突检测）；`packages/core/src/permission.ts` 的 `Reply` 是 `once|always|reject`，另有 `CorrectedError`：用户改写参数后作为反馈回给模型；`Unattended` 上下文给定时任务自动放行或拒绝。

本 fork 现状：`packages/interaction/user-approval/src/types.ts` 只有一次性 `allowed-once`，没有规则匹配、没有持久规则、没有参数纠正；权限粒度是预设（Read Only / Workspace Write / Full access / Auto review），不是 action/resource 规则。

融入方式：`interaction/user-approval` 增加规则求值与持久化规则（存 `packages/storage`）；`client/ui-approval` 增加「总是允许」与「修改后允许」；`packages/schedule` 的无人值守运行改用规则判定，替代当前的 fail-closed。成本中，涉及模型可见路径时要补会话事件。

### 3. HTTP 卡带录制回放

opencode 的 `packages/http-recorder` 装饰 `HttpClient`/`Socket`：首次真实请求写 `test/fixtures/recordings/*.json`，之后回放；`CI=true` 缺卡带直接失败；匹配按「首个未消费的相同交互」原子认领，重复请求按顺序消费以建模重试；写盘前脱敏头、敏感查询参数与 JSON 字段，并扫描 `sk-`、`AIza`、`AKIA`、`gh*_` 等凭据格式，命中即拒写。

本 fork 现状：没有 cassette（全仓 `cassette` 无命中）。现有 `test:snapshot` 是会话事件级重放，provider 适配层的流式增量、错误分类、工具参数拼接只能靠需要真实 key 的 e2e。

融入方式：在 `packages/test-support` 新增录制器，挂在 llm adapter 的 fetch 与 socket 上，产出确定性 provider 金样。成本中低，收益是把适配回归从「需要 key」变为可离线复现。

### 4. MCP OAuth 与连接共享

opencode 的 `packages/core/src/mcp/oauth.ts` 内置 OAuth provider 与凭据选择，slot key 与登录账号同源；`pool.ts` 让同配置的多个 Location 共享连接，握手失败的服务器退化为逐 Location 独占；`socket-client.ts` 是自管的流式客户端。

本 fork 现状：`mcp-client`/`mcp-manager` 有重连预算、`probe`、`restart` 与 `${credential:REF}` 模板，但没有 OAuth、没有连接池（全仓 `oauth`、`pool` 在 `packages/mcp` 无命中）。

融入方式：`mcp-client` 增加 OAuth 授权流程与凭据落点；池化是次要优化。远程 MCP 服务普遍要求授权，这是接入面缺口。成本中。

### 5. 代码模式增强（按需目录、OpenAPI、静态扫描、挂起恢复）

opencode codemode 的四个可借点：

1. 只发签名目录：`packages/core/src/codemode/catalog.ts` 的 `INLINE_BUDGET = 2_000` 字符、描述截断 120 字、按命名空间轮流选签名，目录变化只发增量（`UPDATE_BUDGET = 1_000`）；其余工具靠内建 `search`（字段加权 BM25、前缀与短名偏好）按需发现。
2. OpenAPI 3.x 转工具：`packages/codemode/src/openapi/index.ts` 的 `fromSpec`，`operationId` 的点号造命名空间，认证由主机 `AuthResolver` 在调用时解析、不对模型可见。
3. 静态扫描：`packages/codemode/src/scan.ts` 用 Acorn 提取静态 `tools.*` 调用，定时任务据此先做禁用清单与权限判定再执行。
4. 挂起与恢复：自研字节码 VM 在工具 await 处保存快照续跑（`vm/snapshot/snapshot.ts`），`idempotent` 与 `durable` 决定在途调用语义。

本 fork 现状：`tool-executor-ptc` 每次请求发送完整生成 SDK，README「Token effect」写明成本与可见定义成正比；没有按需目录与 `search`、没有 OpenAPI 导入、没有静态扫描；程序内存随进程结束，没有挂起恢复。

融入方式：先给 `tool-executor-ptc` 增加可选的「目录 + search」模式（保留完整 SDK 模式）；OpenAPI 导入做成实验插件；静态扫描用于无人值守预判；挂起恢复价值最低、放最后。成本中高，可拆项。

### 6. 终端跨重启存活（PTY 守护进程）

opencode 的 `packages/process-daemon` 是 Rust `opencode-pty`：所有权文件 + 私有套接字/命名管道 + token，单所有者连接，继任者凭 120 秒移交票据接管（`src/ownership.rs`），并直接 FFI 链接 libghostty 做终端权威；TS 侧 `packages/core/src/persistent-pty/` 接入。

本 fork 现状：`packages/terminal/terminal/README.md` 明确「Sessions are process-local: they do not survive a harness restart」。

融入方式：不必照搬 Rust 与 libghostty；先做 Node 守护子进程 + 所有权文件 + 断线重连，node-pty 已足够。成本高，收益集中在长任务与重启场景。

### 7. 会话文件回滚（revert）

opencode 的 `packages/core/src/session/revert.ts` 按消息边界用文件快照恢复，`capture`/`restore` 走 `snapshot.ts`，stage 与 commit 两段。

本 fork 现状：`workspace-changes` 已按轮拍 turn 首尾快照并保留到会话销毁，但没有恢复动作。

融入方式：在 `workspace-changes` 上增加「恢复到某轮」动作与 UI 确认；边界要与 sandbox、只读策略和未跟踪文件一致。成本中。

### 8. 侧问面板（btw）

opencode 的 `packages/gui-plugins/src/btw` 是主/渲染进程状态机加侧栏面板：就当前上下文问一句，不进入主会话。

本 fork 现状：没有侧问；`subagent` 只能委派任务并在主会话回报。

融入方式：client 面板 + `subagent-fork-in-process` 的 fork 子会话；默认不把答案写回主会话。成本中低。

### 9. 流式 Markdown 尾部修复（tail heal）

opencode 的 `packages/patchmark/src/heal.ts` 计算尾部修复：未闭合的 `**bold`、`` `code ``、半截链接补闭合或隐藏，只有开头标记没有内容时不显示，避免半截标记闪成标题、分隔线或代码块。

本 fork 现状：`incremental.ts` 只做块级冻结，没有尾部标记修复。

融入方式：在 `ui-primitives` 的 Markdown 渲染前加纯展示层修复。成本低。

### 10. 其他小项

- 聊天内 Mermaid 渲染：opencode 的 `merman` 是终端字符画，不适用；但本 fork 聊天围栏目前不渲染 mermaid（全仓 `mermaid` 只在网站与文档工具中），而仓库规则要求图示用 mermaid。可给围栏委托注册 mermaid 渲染器，根 `package.json` 已有 `mermaid` 11.17.2，注意按需加载与产物体积。
- 按轮聚合 Web 搜索来源：opencode 的 `gui-plugins/src/sources` 按轮聚合 `search`/`fetch` 步骤、去重后给网站图标与展开面板；本 fork 的 `packages/web` 有搜索工具但客户端无来源面板。
- 输出上限续跑：opencode 把 `finish === "length"` 判为 `OutputLimit` 并驱动续跑（`session/runner/step.ts`）；本 fork 的 `agent-loop` 把 `max-tokens` 作为回合结束原因，不再续跑。
- fork 说明注入：opencode 的 `fork-notice` 给分叉会话一段合成消息，说明后台子代理、定时任务与后台 shell 归原会话；本 fork 的 fork 只体现在持久化前缀（`session-persistence-jsonl`），模型侧无提示。
- 工具输入修复：opencode 的 `plugin/tool-input-repair.ts` 按 schema 唯一可解地纠类型并做 `bash→shell` 别名；本 fork 未见对应实现。
- MCP 事件订阅：opencode 有 `watch_mcp_event`；本 fork 的 `mcp-resources` 只读。
- 会话导入：本 fork 只有导出，没有 opencode `session/transfer.ts` 那样的 sanitize 导入。
- 媒体生成族：opencode 的 `ai` 包统一 image/embedding/speech/video 的 `Generation` 句柄（可跨进程续取）；本 fork 有 `experimental/speech-to-text`，没有图像生成。

## 不融入

- Effect、Effect-Drizzle-SQLite 与 drizzle 迁移体系：本 fork 的持久化是 JSONL + 投影 + 世代迁移，换栈会破坏已发布会话格式。
- workerd/Cloudflare Durable Object 运行档、`httpapi-codegen`、发布打包链：部署与发布形态不同。
- Rust process-daemon、libghostty FFI、TUI 的 latex/merman 字符画渲染：形态不匹配，只取「跨重启终端」这一能力。
- GUI 插件 bundle 沙箱（`new Function` 求值 + 模块白名单）：本 fork 走 Cordis 插件包 + 插件市场，替换会重做发布链。
- 模型族专用系统提示（`plugin/optimize.ts` 对 gpt/claude/kimi 等分派不同提示词）：本 fork 是单一 DeepSeek 提示词体系，收益与验证成本不匹配。

## 涉及模块

`packages/llm/*`、`packages/interaction/user-approval`、`packages/client/ui-approval`、`packages/test-support/*`、`packages/mcp/*`、`packages/core/tool-executor-ptc`、`packages/ptc-runtime/*`、`packages/terminal/*`、`packages/deliverables/workspace-changes`、`packages/client/ui-primitives`、`packages/subagent/subagent-fork-in-process`、`packages/schedule/*`。

## 待核验

- pi-ai catalog 是否暴露模型缓存 TTL，决定 warming 的 `auto` 间隔能否照做。
- 当前 MCP SDK 版本是否已带 OAuth provider 接口，决定第 4 项的实现路径。
- PTC 目录增量会改变提示前缀，是否影响现有 KV 缓存复用需实测。
- `workspace-changes` 的快照保留边界能否支撑「恢复到某轮」。
- 尾部 heal 与 `incremental.ts` 的冻结块边界是否冲突（冻结块不可改，只能改尾部）。

## 复发预防

- 判定缺口前先在本 fork 搜同义实现（incremental、spill、jobs、tool_search 等），已覆盖项直接排除。
- 「可插件化」看是否只需公开接缝；需要改 `agent-loop` 或会话格式的项单独评估，并补升级指南。
