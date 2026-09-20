---
type: index
updated: 2026-09-24
---

# Wiki 索引

> 人工/Agent 显式查阅用的完整目录；会话中的导航由 wiki-memory hook 注入的目录树提供。格式：`[页面标题](相对路径) — 一行摘要`。

## 实体 entities

- [pi 后端（pi-agent-loop）](entities/pi-backend.md) — Pi 运行时作为 dsh 第二后端：职责、关键文件、上下游依赖与合并上游后的 API 适配。
- [llm-pi-ai（pi-ai 适配器与提供方路由）](entities/llm-pi-ai.md) — 提供方路由、模型目录解析链，以及无内置目录网关的运行期端点目录读取。
- [统计浮层（StatsFloat）](entities/stats-float.md) — 费用卡片的口径（当前工作区全量会话）、数据源与两条计价路径。
- [A2A 栈（dsh-a2a / dsh-a2a-host / dsh-tool-a2a）](entities/a2a-stack.md) — 自研 A2A：协议层、宿主端点、对等端工具与 Kafka 总线；零依赖、`contextId` 即会话 id、Loader default 导出踩坑、按 a2a-bridge 方案对接的两通道与 skill 契约。
- [文档面板的编辑与保存（workspaceFiles.write）](entities/document-panel-editing.md) — 写接口的守卫与包含性、pane 级编辑器、Typert 产物需根构建重生成，以及 office 预览的 fflate 浏览器入口踩坑与构建期 builtin 守卫。
- [远端工作区 provider（fs-sftp / subprocess-sftp）](entities/remote-workspace-providers.md) — 基于 `ctx.sshSftp` 的远端 fs/subprocess：路径标识、版本与原子发布、终端 pid 发现，以及 Web 工作区不可用的踩坑。
- [fork Web 面板（ui-polish 的 Git/LaTeX/SSH/画布标签页）](entities/fork-web-panels.md) — 面板职责、`/git/*` 路由表（多仓库卡片、规则与生成模型、合并状态）、`ctx.fs` 接缝之外的守卫与编辑边界，以及文件面板去重。
- [LaTeX 面板（/latex 路由与 Overleaf 式编辑流程）](entities/latex-panel.md) — 项目发现/文件树/路径基准、xelatex+bibtex 临时镜像编译链路（含文件数/字节/单文件边界与缺失引用诊断）、字体与 tlmgr 安装、AI 写作的模型路由与安全边界。
- [工作区文件删除（ctx.fs.remove → workspaceFiles.delete → 右侧栏文件树）](entities/workspace-file-deletion.md) — 四层删除链的各层要点、父目录围栏与 `FS_NOT_EMPTY`，以及 `workspaceFiles/remove` 与客户端命名空间服务撞名导致整包启动失败、改方法名后必须重建两侧产物的踩坑。
- [星域多智能体协作（dsh-xingchen）](entities/xingchen-multi-agent.md) — 四角色划分（启明原生路由 + 天权/瑶光/天梁 A2A 专家席）、派发三路径、会话投影与接线位置。

## 概念 concepts

- [SSH/SFTP 能力接缝（ctx.sshSftp）](concepts/ssh-sftp-seam.md) — fork 自研接缝的三角色、包映射、`ctx.ssh` → `ctx.sshSftp` 改名原因，以及 `openExec`/PTY `command`/读取窗口三个新成员。
- [会话格式代际（相邻迁移链）](concepts/session-format-generations.md) — 代与相邻迁移包的关系、bump 判据与 surface 机制属结构性改动、旧代冻结，以及「新增一代」的落地顺序与两个实测踩坑。
- [会话内容宽度轴（--dsh-chat-content-width）](concepts/conversation-width-axis.md) — 记录区/dock/输入卡共用的宽度来源、用户偏好的钳制规则、顶部滑动条的位置与作用域，以及合并覆盖后重建的判据（工厂本地组件拿不到 locale 注入）。

## 源总结 sources

（暂无）

## 决策 decisions

- [合并上游 upstream/master（2026-09）](decisions/2026-09-upstream-sync.md) — 全量合并的来源取舍、`ctx.ssh` 让位、会话 v3 `backend` 字段、CI 与生成物处理。
- [实验能力可视化开关：沿用上游 OPTIONAL_BUNDLES 模式](decisions/2026-09-visual-experimental-toggle.md) — Browser Use / Computer Use / Auto review 成为可选 bundle，Web 插件页一键开关；用户专属配置不进 bundle。
- [跨包运行时导出的重复安装分类（2026-09-19）](decisions/2026-09-19-runtime-export-classification.md) — 六条导出登记 safe 的逐条依据、分类与依赖分区的连带关系，以及四个客户端包 peerDependencies 收敛到 cordis 后的发布布局变化。
- [星域专家席经 A2A 抵达（2026-09-19）](decisions/2026-09-19-xingchen-external-specialist-seats.md) — 三个备选方案（本地预设+子代理、进程内专家会话、A2A 席位）的取舍与后果。
- [A2A 对接改用 a2a-bridge 方案（2026-09-20）](decisions/2026-09-20-a2a-bridge-scheme.md) — 双通道（直连 + Kafka 总线）、skill 契约、配置单一来源，以及不依赖跨仓本地包的理由。

## 查询沉淀 queries

- [本机（Windows）合并与门禁踩坑](queries/windows-merge-gates.md) — tsconfig project reference、bsdtar 盘符、双语配对与生成器分类等失败的现象/根因/解法。
- [fork 客户端栈迁移到上游框架（2026-09-03）](queries/fork-client-stack-migration.md) — 自研 client runtime 退役、面板迁移与两条至今有效的 tsconfig 约定。
- [fork Web UI 修复与快照通道（2026-09-04）](queries/fork-web-ui-repairs.md) — 设置刷新/SSH 面板/模型页按钮/Web 金样漂移的根因与修复。
- [实验能力试验 profile（web-lab）与上游实验插件启用情况](queries/web-lab-profile-and-experimental-plugins.md) — Browser Use / Computer Use / Auto review / 远端工作区各自的前置、验证结果与边界，含 patch 替换语义与 Web 工作区路径校验两个踩坑。
- [pi 后端实现历程与去重/持久化修复（2026-09-05）](queries/pi-backend-implementation.md) — 四个实现阶段与两个用户可见缺陷的根因。
- [A2A v1.0.1 符合性缺口清单（已修）](queries/a2a-v1.0.1-conformance-gaps.md) — 按规范原文逐条核对出的 7 处 MUST 级偏离（推送错误码、扩展卡能力、终态任务三处行为、`A2A-Version` 头、contextId/taskId 校验）与 4 处细节（列表排序、artifacts 省略、游标分页、historyLength），2026-09-18 已全部修复，含修法、错误码映射与复现命令。
- [fork 自研包的门禁红项清单](queries/fork-gate-debt.md) — doc-sync / lint / constraints / 依赖分类 / 覆盖率五类红项的现象、归属与修复方向（fork CI 不跑这些门禁）。
- [CJS 客户端包共享 runtime chunk 导致 web boot 失败](queries/cjs-client-shared-runtime-chunk.md) — ui-polish 内嵌 Excalidraw 后 CJS 构建提升共享 `client.rolldown-runtime.js`，prologue 同步 require 模块表答不了；combo 携带同步闭包 + 相对 chunk 解析的修法与验证。
- [Git/LaTeX 面板重写的缺陷与修复（2026-09-19）](queries/ui-polish-git-latex-defects.md) — 六个缺陷：加载中误报合并、嵌套仓库合并状态读错仓库、多仓库 cwd 回落、LaTeX 读写路径基准、空文件写入被拒、AI 写作默认 provider 空结果。
- [星域包实现缺陷与新包门禁接线（2026-09-19）](queries/xingchen-review-fixes.md) — 九处实现缺陷的根因与修法、新 fork 包的 8 步门禁接线清单、仍未清偿项的归属。
- [总线任务在 A2A 面查不到（a2a-bridge 实测）](queries/a2a-bus-task-visibility.md) — bridge 自身 CLI 经总线派发的任务同样不在任务表里，harness 侧靠事件流收尾故不受影响。
- [会话重载校验报错：assistant/message 空 model 来源（2026-09-24）](queries/session-reload-model-source.md) — 根因三层（校验过严/pi 后端记空/迁移搬运）、加载侧放宽 + 写入侧记真实模型的双层修法与真实数据验证。
- [会话格式 v4：席位答复以 assistant 角色进模型可见内容](queries/session-format-v4-landing.md)
- [工具调度符号丢失导致任何工具调用崩溃（2026-09-24）](queries/tool-scheduler-symbol-duplication.md) — src/lib 两份 `dsh-tools` 各造一个同名 `unique symbol`，`ctx.tools[...]` 取不到调度器；改用 `Symbol.for` 并重建 `lib/`，含真实会话复现与 A2A 实测。 — 为何必须动会话格式、一代迁移包的确切清单，以及本次实施结果与实测踩坑（已实施，写入器 v4）。
