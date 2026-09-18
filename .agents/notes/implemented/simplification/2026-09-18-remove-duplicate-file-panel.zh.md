# Agent Note: 移除重复的文件面板

Status: implemented

[English](2026-09-18-remove-duplicate-file-panel.md) | 中文

## 问题

Web GUI 提供了两种浏览同一批工作区文件的方式：内置的右侧栏「工作区文件」树（`ui-sidebar-files`，与上游文档面板配套）和 `ui-polish` 自己那个标题为「文件」的 `conversation.view` 标签页——它的 `MutationDiffPanel` 从宿主 `/git/list` 路由渲染出第二棵目录树，重复了同样的文件浏览，还在文档面板已有的预览/编辑之上又加了一个编辑器。一件事两个入口分散注意力、把要维护的面翻倍，并让每项与文件相关的改动都要落两遍。

## 决策

文件标签页整体移除。`ui-polish` 不再注册 id 为 `files` 的 `conversation.view` 条目，`MutationDiffPanel` 及其样式表一并删除。只为它存在的宿主路由也随之消失：`/git/list`（树的惰性列表）与 `/git/delete`（同日加入的永久删除动作）。`/git/read` 与 `/git/write` 保留，因为 Git 面板的就地编辑器在用它们。

文件浏览与预览因此回到它们本来就存在的位置：目录树在右侧栏「工作区文件」，打开/预览/编辑在文档预览面板。包 README 记录了这一有意为之的缺席，其功能列表、路由表与 slot 表都不再提到该标签页。

## 备选方案

**保留标签页、删掉右侧栏的树。** 否决：右侧栏的树属于上游文档面板（`ui-sidebar-files` + `ui-sidebar-documentpreview`），fork 一直与上游保持同步；删掉它意味着为 fork 自研面板而与上游布局分道扬镳。

**两者都留，但把标签页改成只读。** 否决：重复本身就是成本——第二棵树仍然要列表路由、i18n、测试与维护。

**保留标签页、只删它的编辑器。** 同样否决，而且编辑器本来也不是本次要处理的部分。

**在删除标签页之前，把删除能力移植到留存的那棵树。** 延期而非否决：右侧栏的树与 `workspaceFiles` Remote 都没有删除操作，移植意味着新增 `ctx.fs` 方法、在每个文件系统 provider（含 helper 方案的 `fs-ssh` wire）中实现，以及新增 Remote 方法。那是一个独立的能力决策，不是删掉一个重复面板的副产物。

## 后果

文件界面只剩一个，fork 的客户端 bundle 少了第二棵树、它的编辑器，以及 `/git/list`、`/git/delete` 两个处理器与它们的测试。Web GUI 目前没有删除文件的能力：同一天早些时候加入的永久删除动作只能从被移除的面板触达，因此随它一起移除，而不是留在一个无人调用的路由上。Git 仍是 `ui-polish` 中唯一能编辑文件的标签页，且它只编辑 git 已跟踪或显示为变更的文件。

## 测试

- `ui-polish` 测试通过：面板用例随文件删除，路由用例裁剪为留存端点；slot 注册测试现在断言 `conversation.view` 的 id 为 `git`、`excalidraw`、`ssh`。
- 手工：Web GUI 顶部标签环为 对话 / 轨迹 / Git / 画布 / SSH，不再有「文件」标签；右侧栏「工作区文件」树照常浏览工作区。
