---
type: index
updated: 2026-09-17
---

# Wiki 索引

> 人工/Agent 显式查阅用的完整目录；会话中的导航由 wiki-memory hook 注入的目录树提供。格式：`[页面标题](相对路径) — 一行摘要`。

## 实体 entities

- [pi 后端（pi-agent-loop）](entities/pi-backend.md) — Pi 运行时作为 dsh 第二后端：职责、关键文件、上下游依赖与合并上游后的 API 适配。

## 概念 concepts

- [SSH/SFTP 能力接缝（ctx.sshSftp）](concepts/ssh-sftp-seam.md) — fork 自研接缝的三角色、包映射，以及 `ctx.ssh` → `ctx.sshSftp` 改名原因。

## 源总结 sources

（暂无）

## 决策 decisions

- [合并上游 upstream/master（2026-09）](decisions/2026-09-upstream-sync.md) — 全量合并的来源取舍、`ctx.ssh` 让位、会话 v3 `backend` 字段、CI 与生成物处理。

## 查询沉淀 queries

- [本机（Windows）合并与门禁踩坑](queries/windows-merge-gates.md) — tsconfig project reference、bsdtar 盘符、双语配对与生成器分类等失败的现象/根因/解法。
