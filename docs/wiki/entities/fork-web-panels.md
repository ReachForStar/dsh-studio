---
title: fork Web 面板（ui-polish 的 Git/SSH/画布标签页）
type: entity
tags: [客户端, ui-polish, git, ssh, excalidraw, 路由, 去重]
created: 2026-09-18
updated: 2026-09-18
sources: []
status: active
---

# fork Web 面板（ui-polish 的 Git/SSH/画布标签页）

## 职责

`@reachforstar/dsh-client-ui-polish` 在会话视图（`conversation.view`）里注册三个标签页——**Git**、**SSH/SFTP**、**画布**（Excalidraw），另有设置行（背景图 / 自动压缩阈值 / 模型费率卡）与统计浮层。这是 fork 自研的 Web 面板族。

文件浏览**不在**这里：右侧栏的内置「工作区文件」树（`ui-sidebar-files`）与文档预览面板负责浏览、预览与编辑，本包不再提供重复的文件标签页（2026-09-18 去重，见下）。

面板的宿主半边（`src/git-service.ts`，由 `index.ts` 注册在 `/git` 前缀路由上）把工作区仓库暴露成一组 JSON 端点；`bg`、`scene` 两个前缀服务背景图与画布场景文件。所有请求的 `cwd` 都要经 `workspaceCwdResolver` 在工作区注册表里解析，未知路径回落到宿主进程 cwd。

## `/git` 路由

| 路由 | 作用 |
| --- | --- |
| `GET /git/status` | 分支 + porcelain 工作树状态 |
| `GET /git/log` | 最近提交 |
| `POST /git/diff {cwd, path}` | 单文件工作树 diff |
| `POST /git/read {cwd, path}` | 文本内容；图片按扩展名返回 data URL（只读预览） |
| `POST /git/write {cwd, path, content}` | 就地覆盖写回（上限 16 MiB） |
| `POST /git/commit {cwd, message}` | `git add -A` + `git commit -m` |
| `POST /git/push {cwd}` | 推送当前分支 |

`read`/`write` 的消费者是 Git 面板的右列就地编辑器（`/git/list`、`/git/delete` 随被移除的文件面板一起删除）。

## 设计要点与边界

- **`/git/*` 不走 `ctx.fs` 接缝，也不走每次调用的沙箱策略**：守卫是 `resolveRepoPath`（拒绝 `..`、绝对路径与反斜杠，要求解析结果落在工作区根下）。因此换 fs provider（例如远端 SFTP 工作区）不会改变这些面板的行为，模型与面板看到的文件也可能不同源。
- **Git 面板只能编辑 git 已跟踪或显示为变更的文件**：它按 `/git/status` 的行渲染，选择某行才走 `/git/read`。
- 画布把场景写进 `<workspace>/.dsh/excalidraw/scene.json`，与模型侧 `excalidraw_*` 工具读写同一文件，靠指纹轮询同步。

## 文件面板去重（2026-09-18）

fork 的「文件」标签页（`MutationDiffPanel`，id `files`）与右侧栏「工作区文件」树重复：同一批文件、两棵目录树、两个编辑器。按用户要求**保留右侧栏（上游）而删除顶部标签页**：`MutationDiffPanel` 与其样式、`diff.*` 文案、只服务于它的 `/git/list` 与同日加入的 `/git/delete` 一并移除（含对应测试），slot 注册只剩 `git`/`excalidraw`/`ssh`。代价是 Web 端暂无删除文件的能力——右侧栏树与 `workspaceFiles` Remote 都没有 remove 操作，要补得从 `ctx.fs` 接缝往下做。决策记录见 [移除重复的文件面板（Agent Note）](../../../.agents/notes/implemented/simplification/2026-09-18-remove-duplicate-file-panel.md)。

## 踩坑

- **改了客户端源码必须重建产物**：`dsh web` 服务的是 `lib/client.js`。`pnpm exec tsc -b packages/client/ui-polish/tsconfig.json` 后再在该包内 `pnpm exec tsdown --env.DSH_BUILD_FACE client`，否则浏览器看到的还是旧面板（本轮去重若只改源码，标签页不会消失）。
- **`slot-catalog.ts` 是生成物**：增删 slot 注册后要跑 `pnpm run gen-client-catalog`，否则 `verify-client-catalog` 报 stale。

## 验证

- 面板与路由：`tests/apply.client.spec.ts`（slot 注册与卸载）、`tests/git-service.host.spec.ts`（路由分发、cwd 解析、路径校验、read/write）、`tests/ssh-panel.client.spec.tsx`、`tests/excalidraw-service.host.spec.ts`。
- 手工：`pnpm dsh web` 顶部标签环为 对话 / 轨迹 / Git / 画布 / SSH（无「文件」），右侧栏「工作区文件」树照常浏览工作区。

## 关联页面

- 决策记录：[移除重复的文件面板（Agent Note）](../../../.agents/notes/implemented/simplification/2026-09-18-remove-duplicate-file-panel.md)
- 上游文件树与文档编辑：[文档面板的编辑与保存](document-panel-editing.md)
- 远端工作区对 fs 接缝的影响：[远端工作区 provider](remote-workspace-providers.md)
- 面板包契约：`packages/client/ui-polish/README.md`
