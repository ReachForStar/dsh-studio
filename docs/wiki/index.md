---
type: index
updated: 2026-11-13
---

# Wiki 索引

> 人工/Agent 显式查阅用的完整目录；会话中的导航由 wiki-memory hook 注入的目录树提供。格式：`[页面标题](相对路径) — 一行摘要`。

## 实体 entities

- [worktree 脏状态镜像（mirrorUncommitted）](entities/worktree-dirty-mirror.md) — `git stash create` 快照 + 未跟踪文件经 `ctx.fs` 逐文件复制，把源检出的未提交工作带进新检出；`mirrorMaxFileBytes` 限制单文件、沙箱策略随调用方、默认不镜像。
- [Arena 模型对比（dsh-arena）](entities/arena.md) — 同一提示并行交给多个模型，各自 worktree 隔离；返回可比较结果，胜者 diff 由调用方显式应用。
- [webhook 活跃会话投递（WebhookMessageRequest）](entities/webhook-channel-delivery.md) — 外部事件除新建会话外可投递到活跃会话（followup / steer），通道运行时三角色的落点与剩余差异。
- [推测执行门控（dsh-speculation）](entities/speculation.md) — 输入前预执行的门控、overlay 代理与预测运行方：只读放行、写入按显式配置重定向到 overlay、越界与未知工具一律 boundary；runner 在轮次结束后预测下一次请求并预执行，用户确认才提交。
- [下一步建议（dsh-followup）](entities/followup.md) — `turn/end` 后用辅助模型给出至多 N 条下一步动作，写 log-only 的 `followup/suggestions` 事件；按 `turn/start` 归属增量累积、空回复不写、UTF-8 安全截断。
- [工具批次摘要（dsh-step-summary）](entities/step-summary.md) — `step/end` 时用辅助模型为工具批次生成一行摘要，以 log-only 的 `tool/batch-summary` 事件记录；增量累积事件不读历史、按 `turn:step` 幂等去重、失败只警告。
- [记忆笔记（dsh-memory-notes）](entities/memory-notes.md) — 读取并注入 `MEMORY.md` 持久记忆：用户层（`<dsh home>/memory`）与项目层（最近根目录）共享 `maxChars` 预算，`agent/pre-step` 每次重读实现编辑更新与删除移除，attribution-only `memory-notes` 来源无需格式代际。
- [工具检索（dsh-tool-search）](entities/tool-search.md) — `tool_search` 按关键词或精确名找回不可见工具的 schema：可见性来自 `ctx.tools.definitions(agent)`、名称命中优先排序、条数与描述长度上限、无匹配时的说明性结果。
- [Agent Plugins v1 加载器（dsh-agent-plugins）](entities/agent-plugins.md) — 把可移植包的 `skills/*/SKILL.md` 与根 `mcp.json` 发布到 `ctx.skills`/`ctx.mcpManager`：manifest 与技能元数据规则、`realpath` 包含性校验、注册名规范化与哈希后缀、只读包文件与 `PLUGIN_DATA` 写入边界。
- [pi 后端（pi-agent-loop）](entities/pi-backend.md) — Pi 运行时作为 dsh 第二后端：职责、关键文件、上下游依赖与合并上游后的 API 适配。
- [llm-pi-ai（pi-ai 适配器与提供方路由）](entities/llm-pi-ai.md) — 提供方路由、模型目录解析链，以及无内置目录网关的运行期端点目录读取。
- [统计浮层（StatsFloat）](entities/stats-float.md) — 费用卡片的口径（当前工作区全部会话及其子会话）、数据源与两条计价路径；总 token、会话数、月度预算对比、当前会话 token 时间线、各会话成本行与宿主进程/系统读数（2 秒轮询），以及预算双 store 同步的原因。
- [A2A 栈（dsh-a2a / dsh-a2a-host / dsh-tool-a2a）](entities/a2a-stack.md) — 自研 A2A：协议层、宿主端点、对等端工具、状态网关与 Kafka 总线；零依赖、`contextId` 即会话 id、Loader default 导出踩坑、按 a2a-bridge 方案对接的两通道与 skill 契约，以及 `kafka-detect` 的启动与失败留证。
- [文档面板的编辑与保存（workspaceFiles.write）](entities/document-panel-editing.md) — 写接口的守卫与包含性、pane 级编辑器、Typert 产物需根构建重生成，以及 office 预览的 fflate 浏览器入口踩坑与构建期 builtin 守卫。
- [远端工作区 provider（fs-sftp / subprocess-sftp）](entities/remote-workspace-providers.md) — 基于 `ctx.sshSftp` 的远端 fs/subprocess：路径标识、版本与原子发布、终端 pid 发现，以及 Web 工作区不可用的踩坑。
- [fork Web 面板（ui-polish 的 Git/LaTeX/SSH/画布标签页）](entities/fork-web-panels.md) — 面板职责、`/git/*` 路由表（多仓库卡片、规则与生成模型、合并状态）、`ctx.fs` 接缝之外的守卫与编辑边界，以及文件面板去重。
- [LaTeX 面板（/latex 路由与 Overleaf 式编辑流程）](entities/latex-panel.md) — 项目发现/文件树/路径基准、xelatex+bibtex 临时镜像编译链路（含文件数/字节/单文件边界与缺失引用诊断）、字体与 tlmgr 安装、AI 写作的模型路由与安全边界。
- [工作区文件删除（ctx.fs.remove → workspaceFiles.delete → 右侧栏文件树）](entities/workspace-file-deletion.md) — 四层删除链的各层要点、父目录围栏与 `FS_NOT_EMPTY`，以及 `workspaceFiles/remove` 与客户端命名空间服务撞名导致整包启动失败、改方法名后必须重建两侧产物的踩坑。
- [星域多智能体协作（dsh-xingchen）](entities/xingchen-multi-agent.md) — 四角色划分、本地与 A2A 席位的配置判断、派发入口、会话投影与现有预设接线；2026-10-27 新增 `autoRoute` 自动路由（`enabled` + `holdRole`）接入 `agent/pre-step`。
- [本地 A2A 联调栈（deploy/a2a）](entities/local-a2a-stack.md) — 一条命令拉起 Kafka + 三网关 + Web；已运行则跳过、Kafka 停了自动重启、配置单一来源（`A2A_CONFIG`）与运行期日志位置；Linux 上 `sg docker` 提权、网关 `npm ci` 前置、9310 双占用让位规则。
- [论文阅读器（ui-paper-reader）](entities/ui-paper-reader.md) — 右侧栏 PDF 阅读页：宿主 `/paper-reader` 与 `/paper-reader/translate` 路由、PDF.js Worker 与内联资源、归一化高亮几何、选中菜单四项动作（提问填草稿不发送、翻译走 `dsh-llm/route` 流式译文）与 8 语言文案。
- [会话永久删除（SessionPersistence.delete → workspace/deleteSession）](entities/session-permanent-deletion.md) — 持久化接缝删除会话产物、注册表清理记账与归档/置顶引用、宿主命令与两次点击确认对话框；只删日志，不碰工作区文件。
- [聊天内 Mermaid 渲染（ui-markdown-mermaid）](entities/chat-mermaid-rendering.md) — `conversation.chat.markdown.fence` 的 `mermaid` 层：流式与绘制失败回退 owner 代码块、注入面持有渲染器与 id 序列、动态 import + 私有打包的体积实测，以及 `suppressErrorRendering` 这一失败回退前提。

## 概念 concepts

- [SSH/SFTP 能力接缝（ctx.sshSftp）](concepts/ssh-sftp-seam.md) — fork 自研接缝的三角色、包映射、`ctx.ssh` → `ctx.sshSftp` 改名原因，以及 `openExec`/PTY `command`/读取窗口三个新成员。
- [会话格式代际（相邻迁移链）](concepts/session-format-generations.md) — 代与相邻迁移包的关系、bump 判据与 surface 机制属结构性改动、旧代冻结，以及「新增一代」的落地顺序与两个实测踩坑。
- [会话内容宽度轴（--dsh-chat-content-width）](concepts/conversation-width-axis.md) — 记录区/dock/输入卡共用的宽度来源、用户偏好的钳制规则、顶部滑动条的位置与作用域，以及合并覆盖后重建的判据（工厂本地组件拿不到 locale 注入）。

## 源总结 sources

（暂无）

## 决策 decisions

- [合并上游 upstream/master（2026-09）](decisions/2026-09-upstream-sync.md) — 全量合并的来源取舍、`ctx.ssh` 让位、会话 v3 `backend` 字段、CI 与生成物处理；后续轮次补充全覆盖表的补行口径、持久化后继记录、环境前置三项，以及 2026-10-30 的新增必要抽象成员、跨 profile 一致性例外表、删包与删工作流的残骸处理。
- [实验能力可视化开关：沿用上游 OPTIONAL_BUNDLES 模式](decisions/2026-09-visual-experimental-toggle.md) — Browser Use / Computer Use / Auto review 成为可选 bundle，Web 插件页一键开关；用户专属配置不进 bundle。
- [跨包运行时导出的重复安装分类（2026-09-19）](decisions/2026-09-19-runtime-export-classification.md) — 六条导出登记 safe 的逐条依据、分类与依赖分区的连带关系，以及四个客户端包 peerDependencies 收敛到 cordis 后的发布布局变化。
- [星域专家席经 A2A 抵达（2026-09-19）](decisions/2026-09-19-xingchen-external-specialist-seats.md) — 已被当前本地/A2A 可选席位模式取代；保留早期三个方案的取舍与后果。
- [A2A 对接改用 a2a-bridge 方案（2026-09-20）](decisions/2026-09-20-a2a-bridge-scheme.md) — 双通道（直连 + Kafka 总线）、skill 契约、配置单一来源，以及不依赖跨仓本地包的理由。
- [启动器改用构建产物面（2026-09-24）](decisions/2026-09-24-launcher-artifact-plane.md) — 三个方案取舍；插件行永远由加载器解析到 `lib/`，故默认 `dsh` 改走产物面（新增 `dsh:source` 保留 tsx 向量），以及门禁与文档的连带更新。

## 查询沉淀 queries

- [会话统计 Token 用量并入子会话与标题调用](queries/session-token-usage-subagents.md) — 胶囊、统计浮层与标题调用的用量口径：两路展开子会话，`session/title-llm-usage` 记录独立模型调用并进入 `tokenUsage`；含持久化确认与未覆盖边界。
- [QwenLM/qwen-code 能力面与可融入清单](queries/qwen-code-capability-comparison.md) — 11 项候选按优先级排序：Agent Plugins v1 原生加载、自动记忆、通道运行时、上下文成本逐项 + `tool_search`、快模型三件套（推测执行 / 下一步建议 / 工具批次摘要）、Arena 与脏状态 worktree、文件历史、Advisor、文件变更钩子、`--json-schema`、托管运行时后端；含不融入项与逐条落点。
- [qwen-code 采纳工作交接](queries/qwen-code-handoff.md) — 已完成与未完成项、出厂组合接线（星域预设 4 行 + 宿主层 4 行）、门禁与踩坑清单、临时文件授权状态。
- [论文阅读器翻译与会话永久删除](queries/paper-reader-translation-and-session-delete.md) — 已实现：`dsh-llm/route` 候选路由与 NDJSON 翻译、按页全文翻译与译文卡片；`SessionPersistence.delete` + `workspace/deleteSession` 的删除链、拒绝码、二次确认与 100% 覆盖率验证。
- [回复延迟：codearts 上游排队导致每步等待](queries/session-command-followup-latency.md) — 慢时段首字 63–73 秒中排队 56–62 秒（`tries[].queued`），源自 `codearts` 提供方 `maxConcurrency: 1`；本地开销中位 18 毫秒，同账号兄弟模型同日首字 7.9 秒。
- [本机经 SOCKS5 代理推送 GitHub](queries/github-push-via-socks-proxy.md) — 直连 SSH 与 HTTPS 都不通时，用 `127.0.0.1:7890` 的 SOCKS5 加 `GIT_SSH_COMMAND` 完成推送；含只读核对与失败阶段分辨。
- [本机（Windows）合并与门禁踩坑](queries/windows-merge-gates.md) — tsconfig project reference、bsdtar 盘符、双语配对与生成器分类等失败的现象/根因/解法；含 2026-09-26 轮的 AMSI 崩溃、git 时限竞态、分组复跑法与 unknown-cast 基线重生成。
- [fork 客户端栈迁移到上游框架（2026-09-03）](queries/fork-client-stack-migration.md) — 自研 client runtime 退役、面板迁移与两条至今有效的 tsconfig 约定。
- [fork Web UI 修复与快照通道（2026-09-04）](queries/fork-web-ui-repairs.md) — 设置刷新/SSH 面板/模型页按钮/Web 金样漂移的根因与修复。
- [实验能力试验 profile（web-lab）与上游实验插件启用情况](queries/web-lab-profile-and-experimental-plugins.md) — Browser Use / Computer Use / Auto review / 远端工作区各自的前置、验证结果与边界，含 patch 替换语义与 Web 工作区路径校验两个踩坑。
- [pi 后端实现历程与去重/持久化修复（2026-09-05）](queries/pi-backend-implementation.md) — 四个实现阶段与两个用户可见缺陷的根因。
- [A2A v1.0.1 符合性缺口清单（已修）](queries/a2a-v1.0.1-conformance-gaps.md) — 按规范原文逐条核对出的 7 处 MUST 级偏离（推送错误码、扩展卡能力、终态任务三处行为、`A2A-Version` 头、contextId/taskId 校验）与 4 处细节（列表排序、artifacts 省略、游标分页、historyLength），2026-09-18 已全部修复，含修法、错误码映射与复现命令。
- [fork 自研包的门禁红项清单](queries/fork-gate-debt.md) — doc-sync / lint / constraints / 依赖分类 / 覆盖率红项的现象、归属与修复方向；2026-10-30 复检补齐 `hygiene` 的 12 门清单，其中包元数据、客户端文案与文档相对路由三门已同日清偿。
- [客户端文案、包元数据与文档相对路由三门禁的清偿](queries/client-copy-and-locale-metadata.md) — 三门的判定规则、16 包 × 8 语言的元数据约定与 manifest 导出、5 处文案与 4 条路由的改法，以及 `-/X` 被当成斜杠命令 token 的踩坑。
- [CJS 客户端包共享 runtime chunk 导致 web boot 失败](queries/cjs-client-shared-runtime-chunk.md) — ui-polish 内嵌 Excalidraw 后 CJS 构建提升共享 `client.rolldown-runtime.js`，prologue 同步 require 模块表答不了；combo 携带同步闭包 + 相对 chunk 解析的修法与验证，组装启动夹具按同一函数排 chunk 的修复，以及压缩单行产物下改为整份扫描的闭包收集。
- [Git/LaTeX 面板重写的缺陷与修复（2026-09-19）](queries/ui-polish-git-latex-defects.md) — 六个缺陷：加载中误报合并、嵌套仓库合并状态读错仓库、多仓库 cwd 回落、LaTeX 读写路径基准、空文件写入被拒、AI 写作默认 provider 空结果。
- [星域包实现缺陷与新包门禁接线（2026-09-19）](queries/xingchen-review-fixes.md) — 九处实现缺陷的根因与修法、新 fork 包的 8 步门禁接线清单、仍未清偿项的归属。
- [星域预设不可见与普通消息没有回复（2026-10-02）](queries/xingchen-usability.md) — 入站 A2A Host 状态误用于隐藏本地预设（已修）；启明与 standard 在 `amax/c-y2/gpt-6-sol` 上的失败属于该路由上游，与专家派发无关，且既有会话不会随全局默认值换模型。
- [总线任务在 A2A 面查不到（a2a-bridge 实测）](queries/a2a-bus-task-visibility.md) — bridge 自身 CLI 经总线派发的任务同样不在任务表里，harness 侧靠事件流收尾故不受影响。
- [会话重载校验报错：assistant/message 空 model 来源（2026-09-24）](queries/session-reload-model-source.md) — 根因三层（校验过严/pi 后端记空/迁移搬运）、加载侧放宽 + 写入侧记真实模型的双层修法与真实数据验证。
- [会话格式 v4：席位答复以 assistant 角色进模型可见内容](queries/session-format-v4-landing.md) — 为何必须动会话格式、一代迁移包的确切清单，以及本次实施结果与实测踩坑（写入器曾为 v4，现为 v5）。
- [工具调度符号丢失导致任何工具调用崩溃（2026-09-24）](queries/tool-scheduler-symbol-duplication.md) — src/lib 两份 `dsh-tools` 各造一个同名 `unique symbol`，`ctx.tools[...]` 取不到调度器；改用 `Symbol.for` 并重建 `lib/`，含真实会话复现与 A2A 实测。
- [桌面版 A2A 状态页报 Kafka 不可用（asar 内 compose 路径）](queries/desktop-a2a-kafka-unavailable.md) — 打包后 compose 位于 `app.asar` 内、`docker` 子进程读不到路径（Electron 的 fs 能读），空 `catch` 又吞掉了原因；改为内容经 stdin 传入、固定项目名、回传失败类别与诊断，含 Electron 实测证据、状态页渲染修复，以及相关五个文件覆盖率追到每文件 100% 的注入点设计。
- [Windows 侧 .git 迁到 Linux 后 Lefthook 钩子安装被拒](queries/lefthook-hookspath-cross-platform.md) — `config.worktree` 与归属标记里的 Windows 绝对路径在 Linux 下既过不了 `isAbsolute()` 校验，又被 git 当相对路径解析成仓库根下的怪名字目录；三步就地修法与自查命令。
- [会话格式 v5 落地与 v4→v5 包的合并修复（2026-09-26）](queries/session-format-v5-landing.md) — `deferLoading` 与 tool-change 标签的迁移层越界、README 代际位移重建、v4 历史格式归档流程，以及 fork 自有 v4 日志读不出的遗留项；含 2026-10-15 合并上游时补的 v4 源准入词汇与 catalog 事实缺口。
- [合并上游 upstream/master（2026-10-15）](queries/upstream-merge-2026-10.md) — 用合并前 HEAD 工作树作基线区分「合并引入/预存/偶发」的判定口径、本轮三类修复（v4 源准入词汇、vfs-example 夹具代际、corpus 策略规格自洽）与 fork 私有包在位核对。
- [合并上游 upstream/master（2026-10-27，rc.3 同步）](queries/upstream-merge-2026-10-27.md) — 176 文件 / 441 块冲突：批量工具接口与 `Agent.model` 的 fork 适配、持久化 schema v1→v2 历史归档重编码、生成物重生成顺序、6 处合并丢失的 i18n 键，以及 88 条既有 lint 红项的归因；收尾快进 `master` 并推送 `me`。
- [合并上游 upstream/master（2026-10-18）](queries/upstream-merge-2026-10-18.md) — 0.2.1-rc.2 增量合并：20 个冲突按来源取舍、系统提示词快照经 refresh 重生成、基线工作树不可用时降级为「夹具 + 因果源码零差异」代码证据判定，以及本轮红灯归因清单。
- [合并上游 upstream/master（2026-10-29，0.2.2-alpha.2 同步）](queries/upstream-merge-2026-10-29.md) — 413 文件 / 534 块冲突（343 个纯版本号）：LiveShare 端点全覆盖表补 fork 端点、上游新函数不认 linux-x64、装配页 `/remote` 重写只认上游作用域、持久化后继记录补记与 Node/git/locale 三项环境前置。
- [合并上游 upstream/master（2026-10-30）](queries/upstream-merge-2026-10-30.md) — 351 个提交、67 个冲突文件；`ctx.fs` 三个新抽象成员与 `fs-sftp` 补齐、`ui-sidebar-files` 重写后的删除功能重建、SDK/Desktop 工具一致性例外登记，以及 8 处合并引入缺陷的修法。
- [合并上游 upstream/master（2026-11-08）](queries/upstream-merge-2026-11-08.md) — 926 个提交、148 个冲突文件；宽度滑块与桌面更新通道的逐块合并、8 处合并引入缺陷的修法、27 项 fork 修复的归属核对（仅 3 项由上游解决），以及插件化三类划分（整包能力可插件化，持久化格式/能力接缝/工具卡契约/宽度滑块/桌面外壳必须留 fork）。
- [合并上游 upstream/master（2026-11-12，0.2.2-rc.2）](queries/upstream-merge-2026-11-12.md) — 923 个提交、85 个冲突文件；office 改由 office-kit 承载、运行期提醒加 `<system-reminder>` 框架、Team 包迁移与账号包删除的 fork 适配，`filesFace` 七参重排与 `pending` 撞名处理，ui-theme 两条新样式门禁的清偿，「先删旧 v5 夹具再 refresh」让 `test:snapshot` 从 236 红降到 7 红的手法，以及合并后 fork 入口消失（ui-polish 压缩产物闭包、星域预设挂已删子入口）的复盘与修法。
- [fork 发布 dsh 0.2.1-rc.2 的流程与门禁踩坑](queries/fork-release-dsh-0.2.1-rc.2.md) — verify/build:official/pack/zip/release 一条链的顺序要求：家族同版本、workspace:* 协议、构建记录绑定 HEAD，以及同名 tag 更新走删除+新建；2026-10-30 复核家族 391 个成员与上游同版本，无需改动
- [Linux 桌面 deb 安装包与 Release 工作流](queries/desktop-deb-release.md) — 四平台 Release 构建、Linux 蓝色鲸鱼及标准尺寸图标、客户端发布文件完整性与 ASAR Office 解析；含本机重打包的两个网络问题（坏代理拖垮 npm 下载、`@electron/get` 的 SHASUMS 行格式）与本地镜像做法；2026-10-27 补 Release 桌面包三触发（published / `dsh-v*` tag push / 手动 `release_tag` 补传）与按 target 校验非空。
- [Cua Driver 检测补全与入口迁移（2026-10-27）](queries/cua-driver-detect-and-placement.md) — 检测补齐安装器写入的稳定路径（`~/.local/bin`、`~/.cua-driver/packages/current`、Windows `LOCALAPPDATA`）并按 `X_OK` 判定，check 路由回报 `path`；安装入口从插件卡片 footer 迁到「计算机操作」详情页，安装后自动重检。
- [任务列表跨轮次消失与状态不回写（2026-10-27）](queries/todo-list-lifetime-and-status.md) — `todos` 投影不再在 `turn/start` 清空（`stateVersion` 2→3），列表跨轮次保留；状态仍归模型 `todo_write` 全量重写，描述追加轮次结束前回写纪律。
- [持久化历史分叉与来源种类补记（2026-10-27）](queries/persistence-history-fork-repair.md) — v5 记录快照重编码为 v2 布局、`action-card-status` 的 4 个共享根重排为 v5→action-card-status 消分叉、`assistant/peer-message` 来源联合新增 `action-cards` 补 `same-version` 记录；含「判断某根是否需记录要读门禁 tips」的复发预防。
- [发布 dsh 0.2.1-rc.3（含四平台桌面安装包）](queries/release-dsh-0.2.1-rc.3.md) — 家族版本对齐→`build:official`→`pack`→`tag -f`→`gh release create`（不带 `--target`）的完整流程，同名 tag 上移、手打路径被显示层掩码引发的误判与 `git add -u` 绕法、桌面工作流双触发。
- [桌面未签名构建指向发布页的更新源（2026-10-27）](queries/desktop-github-release-update-feed.md) — `DSH_DESKTOP_UPDATE_RELEASES_URL` 让 unsigned 的 Windows/Linux 包带更新源、macOS 排除；含三种 GitHub 资产地址的实测状态（`releases/download` 404）、本地打包产出的 `nightly-linux.yml` 与应用内 `app-update.yml` 证据、以及「feed 依赖 Latest」的约束。
- [opencode v2.2.7 能力面与可融入清单](queries/opencode-v2-capability-comparison.md) — 排除 12 项已覆盖能力后，按优先级给出 10 项候选：缓存保活、权限规则化与参数纠正、HTTP 卡带录制、MCP OAuth、代码模式按需目录/OpenAPI/静态扫描、跨重启终端、会话文件回滚、侧问面板、尾部 heal、聊天内 mermaid；含不融入项（Effect/Drizzle、Rust daemon、插件 bundle 沙箱）与待核验前提。
- [opencode 能力落地交接（余 5 项）](queries/opencode-capability-handoff.md) — 前 10 项已交付（缓存保活、卡带、OpenAPI、尾部修复、Mermaid、续跑、fork 提示、参数修复、MCP 订阅、来源面板）；余下权限规则化、MCP OAuth、PTC 按需目录、侧问面板、会话导入的现状、落点、验收与已知缺口。
- [openai/codex 能力面与可融入清单](queries/codex-capability-comparison.md) — 排除 11 项已覆盖能力后，按优先级列出执行策略（Starlark 前缀规则与“批准并追加规则”）、审批结果词汇、世界状态增量注入、代码模式 exec/wait、apply_patch、钩子事件面、压缩矩阵、rollout-trace、消息板/代理图/树预算、记忆写管线、外部迁移、沙箱网络与拒绝反馈等 13 项及落点。
- [codex 能力落地交接（12 项）](queries/codex-capability-handoff.md) — 每项的现状、codex 参考路径、落地步骤、验收与风险；含推荐批次（权限/审批/钩子 → 世界状态 → apply_patch/代码模式 → 压缩 → 多智能体/记忆 → 沙箱与收尾）、已由并行会话完成的 PTC 预算目录与会话导入、全局门禁与约束。
