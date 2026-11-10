---
title: 会话永久删除（SessionPersistence.delete → workspace/deleteSession）
type: entity
tags: [session, persistence, workspace, delete, fork]
created: 2026-11-10
updated: 2026-11-10
sources: []
status: active
---

# 会话永久删除（SessionPersistence.delete → workspace/deleteSession）

## 职责

把「彻底删除一个会话」收敛成一条链：持久化接缝删除磁盘产物，工作区注册表清理全部引用，宿主 Remote 暴露命令，客户端菜单与二次确认调用它。删除范围只有会话记录与消息日志；工作区文件与工作树不参与。

## 关键文件与接口

| 层 | 文件 | 要点 |
| --- | --- | --- |
| 持久化契约 | `packages/session/session-persistence/src/index.ts` | 抽象 `delete(id, options?)`：返回是否删除；未知 id 为 `false`；写句柄持有时 `SessionAlreadyOwnedError` |
| JSONL 后端 | `packages/session/session-persistence-jsonl/src/index.ts` | 先按 id 找到当前代产物，取得内核写锁后 `rm` 整个会话目录；中止在途历史迁移；未实体化会话直接拒绝 |
| 注册表 | `packages/workspace/workspace/src/index.ts` | `deleteSession`：拒活动/打开会话 → 删日志 → 清头部与路径缓存 → `detachSession` → 清归档/置顶集合 |
| 宿主命令 | `packages/api/workspace-controller/src/{index,commands,types}.ts` | `@Remote('deleteSession')` 返回 `{ deleted }`；拒绝码 `workspace/session-open`、`workspace/session-active` |
| 客户端服务 | `packages/api/workspace-controller/src/client/{model,service}.ts` | `IWorkspaces.deleteSession`；`WorkspaceDeleteSessionError` 携带 `rpcError` |
| 客户端界面 | `packages/client/ui-workspace/src/client/` | 菜单项 `session.delete`（order 700，danger）、`DeleteSession.tsx` 对话框、`navigation.ts` 清主选择、成功后 `sessions.refresh()` |

## 行为要点

- **只删日志**：`delete` 只经持久化后端删除会话产物；注册表与界面都不触碰工作区文件、工作树或目录。
- **活动与打开态优先**：注册表先查 `ctx.sessions`，再走 `workspace/session-activity` waterfall；两者任一命中都在写入前拒绝，客户端分别本地化为「仍打开」「仍有工作」。
- **幂等**：未知 id 仍执行同样的引用清理并返回 `false`；重复点击或崩溃后重试不会报错。
- **二次确认**：对话框第一次点击进入待确认，第二次才调用删除；取消不写入。归档行使用同一菜单，因此已归档会话也可删除。
- **列表同步**：删除成功后客户端刷新宿主权威会话列表；归档/置顶集合与 Workspace 记录由 `domain/changed` 推送自动更新。

## 关联页面

- [论文阅读器翻译与会话永久删除](../queries/paper-reader-translation-and-session-delete.md)：原始方案与验收记录。
- [工作区文件删除](workspace-file-deletion.md)：另一条删除链，范围与命名空间不同。
- 升级指南 `docs/upgrade-guide/v0.2.2-rc.1/session-persistence-delete/`：仓库外后端需实现抽象方法。
