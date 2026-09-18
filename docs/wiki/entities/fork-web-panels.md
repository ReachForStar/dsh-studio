---
title: fork Web 面板（ui-polish 的文件/Git/SSH/画布标签页）
type: entity
tags: [客户端, ui-polish, 文件面板, git, 删除, 路由]
created: 2026-09-18
updated: 2026-09-18
sources: []
status: active
---

# fork Web 面板（ui-polish 的文件/Git/SSH/画布标签页）

## 职责

`@reachforstar/dsh-client-ui-polish` 在会话视图（`conversation.view`）里注册四个标签页——**文件面板**（`MutationDiffPanel`）、**Git**、**SSH/SFTP**、**画布**（Excalidraw），外加设置行与统计浮层。这是 fork 自研的 Web 面板，与上游的 `ui-sidebar-files`（右侧栏文件树，只读）不是同一个东西。

面板的宿主半边（`src/git-service.ts`，注册在 `index.ts` 的 `/git` 前缀路由上）把工作区仓库暴露成一组 JSON 端点；`bg`、`scene` 两个前缀服务背景图与画布场景文件。所有请求的 `cwd` 都要经 `workspaceCwdResolver` 在工作区注册表里解析，未知路径回落到宿主进程 cwd。

## 文件面板

| 路由 | 作用 |
| --- | --- |
| `POST /git/list {cwd, dir?}` | 一层目录列表（目录优先、再按名字），`dir` 省略时是工作区根 |
| `POST /git/read {cwd, path}` | 文本内容；图片按扩展名返回 data URL（只读预览） |
| `POST /git/write {cwd, path, content}` | 就地覆盖写回（上限 16 MiB） |
| `POST /git/delete {cwd, path, recursive?}` | 永久删除：文件直接删；目录仅在 `recursive: true` 时连同内容删除 |

客户端状态在 `MutationDiffPanel.tsx` 内：`rootItems`（根层）、`children`（按目录缓存的子层）、`expanded`（展开集合）、`selected`/`content`/`imageDataUrl`（右侧编辑区）。删除流程：行内删除按钮 → `Modal` 确认（目录文案点明内容一并删除）→ `gitFetch('/git/delete')` → 重读根与**所有已展开层级** → 若被删条目正是选中路径或其祖先，清空编辑区并收缩相关展开项。

## 设计要点与边界

- **`/git/*` 不走 `ctx.fs` 接缝，也不走每次调用的沙箱策略**：守卫是 `resolveRepoPath`（拒绝 `..`、绝对路径与反斜杠，要求解析结果落在工作区根下），与 `read`/`write`/`list` 完全一致。因此换 fs provider（例如远端 SFTP 工作区）不会改变这些面板的行为，模型与面板看到的文件也可能不同源。
- **删除是永久的**：没有回收站、撤销或恢复路径；目录删除连同内容。`README.md` 的已知限制里已登记。
- **服务端双重把关**：拒绝工作区根；用 `lstat` 判定类型（符号链接按链接删，不跟随目标）；非空目录未带 `recursive` 直接拒绝并点名该标志。
- 行内删除按钮与条目按钮是**兄弟节点**（HTML 不允许按钮嵌套），可访问名是 `删除 <名字>`，测试里据此精确定位。

## 踩坑

- **Modal 的两个「取消」会撞测试查询**：把 `closeLabel` 与 footer 取消按钮都设成同一个文案时，`getByRole('button', { name: '取消' })` 会同时命中关闭图标与页脚按钮。关闭用 `diff.close`、页脚用 `diff.cancel` 两个不同 key。
- **改了客户端源码必须重建产物**：`dsh web` 服务的是 `lib/client.js`。`pnpm exec tsc -b packages/client/ui-polish/tsconfig.json` 后再 `pnpm exec tsdown --env.DSH_BUILD_FACE client`（该包内执行），否则浏览器看到的还是旧面板。
- **目录树查询要区分行内按钮**：条目按钮的可访问名是名字本身（图标 `aria-hidden`），删除按钮是 `删除 <名字>`，正则 `^名字` 才能唯一定位。

## 验证

- 宿主：`tests/git-service.host.spec.ts` 覆盖删除/拒绝/递归/根/逃逸；客户端 `tests/mutation-diff.client.spec.tsx` 覆盖确认拦截、取消不发请求、目录带 `recursive`、重读层级。
- 手工（2026-09-18）：`pnpm dsh web` → 打开 `deepseek-harness` 工作区的「文件」标签页 → 展开 `tmp/` → 删除临时文件 → 确认弹窗文案正确、列表该行消失、磁盘文件已不存在。

## 关联页面

- 决策记录：[fork 文件面板的永久删除（Agent Note）](../../../.agents/notes/implemented/feature/2026-09-18-file-panel-delete.md)
- 上游文件树与文档编辑：[文档面板的编辑与保存](document-panel-editing.md)
- 远端工作区对 fs 接缝的影响：[远端工作区 provider](remote-workspace-providers.md)
- 面板包契约：`packages/client/ui-polish/README.md`
