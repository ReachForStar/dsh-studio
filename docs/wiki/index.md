---
type: index
updated: 2026-09-17
---

# Wiki 索引

> 人工/Agent 显式查阅用的完整目录；会话中的导航由 wiki-memory hook 注入的目录树提供。格式：`[页面标题](相对路径) — 一行摘要`。

## 实体 entities

- [pi 后端（pi-agent-loop）](entities/pi-backend.md) — Pi 运行时作为 dsh 第二后端：职责、关键文件、上下游依赖与合并上游后的 API 适配。
- [llm-pi-ai（pi-ai 适配器与提供方路由）](entities/llm-pi-ai.md) — 提供方路由、模型目录解析链，以及无内置目录网关的运行期端点目录读取。
- [统计浮层（StatsFloat）](entities/stats-float.md) — 费用卡片的口径（当前工作区全量会话）、数据源与两条计价路径。
- [A2A 栈（dsh-a2a / dsh-a2a-host / dsh-tool-a2a）](entities/a2a-stack.md) — 自研 A2A：协议层、宿主端点与对等端工具；零依赖、`contextId` 即会话 id、Loader default 导出踩坑。

## 概念 concepts

- [SSH/SFTP 能力接缝（ctx.sshSftp）](concepts/ssh-sftp-seam.md) — fork 自研接缝的三角色、包映射，以及 `ctx.ssh` → `ctx.sshSftp` 改名原因。
- [会话内容宽度轴（--dsh-chat-content-width）](concepts/conversation-width-axis.md) — 记录区/dock/输入卡共用的宽度来源、用户偏好的钳制规则，以及滑块控件。

## 源总结 sources

（暂无）

## 决策 decisions

- [合并上游 upstream/master（2026-09）](decisions/2026-09-upstream-sync.md) — 全量合并的来源取舍、`ctx.ssh` 让位、会话 v3 `backend` 字段、CI 与生成物处理。

## 查询沉淀 queries

- [本机（Windows）合并与门禁踩坑](queries/windows-merge-gates.md) — tsconfig project reference、bsdtar 盘符、双语配对与生成器分类等失败的现象/根因/解法。
- [fork 客户端栈迁移到上游框架（2026-09-03）](queries/fork-client-stack-migration.md) — 自研 client runtime 退役、面板迁移与两条至今有效的 tsconfig 约定。
- [fork Web UI 修复与快照通道（2026-09-04）](queries/fork-web-ui-repairs.md) — 设置刷新/SSH 面板/模型页按钮/Web 金样漂移的根因与修复。
- [pi 后端实现历程与去重/持久化修复（2026-09-05）](queries/pi-backend-implementation.md) — 四个实现阶段与两个用户可见缺陷的根因。
