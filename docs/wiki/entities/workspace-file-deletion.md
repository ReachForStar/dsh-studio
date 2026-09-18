---
title: 工作区文件删除（ctx.fs.remove → workspaceFiles.delete → 右侧栏文件树）
type: entity
tags: [文件系统, 客户端, ui-sidebar-files, workspaceFiles, 删除, 沙箱, 远端]
created: 2026-09-18
updated: 2026-09-18
sources: []
status: active
---

# 工作区文件删除（ctx.fs.remove → workspaceFiles.delete → 右侧栏文件树）

## 职责

一条贯穿四层的删除链，让浏览器里右侧栏「工作区文件」树能删掉工作区里的条目（永久删除 + 二次确认）：

```
ui-sidebar-files 行内删除按钮 → Modal 确认
  → remote.workspaceFiles.delete(sessionId, path, { recursive })
    → WorkspaceFiles.delete（宿主服务，workspaceFileScope 定工作区根）
      → ctx.fs.remove(path, { cwd, recursive }, signal, policy)
        → fs-local / fs-sandbox / fs-ssh(+helper) / fs-sftp
```

## 各层要点

- **`ctx.fs.remove(path, opts?, signal?, sandboxPolicy?)`**（`packages/fs/fs`）：接缝里唯一按**路径**寻址的变更操作，与 `lstat` 对称。`resolve()` 跟随末段符号链接，因此它命名的 target 无法命名“链接本身”——删除必须绕开 target。语义：`lstat` 探测、符号链接按链接删、目录仅在 `recursive` 下连同内容删、非空目录不带 `recursive` 报新码 `FS_NOT_EMPTY`、返回 `FsRemoveOutcome.kind`。**不带版本守卫**：删除以路径陈述而非从内容推导。
- **`fs-local`**：`fsio.ts` 的 `removePath()` 用 `rm(path, { recursive: true, force: false })`（Node 的 `rm` 不跟随树内链接）。
- **`fs-sandbox`**：围栏**父目录**的规范化路径而不是条目本身（条目可能正是链接，先解析会围栏错误的路径）；`read-only` 直接拒绝；符号链接祖先仍 realpath 进检查。
- **`fs-ssh` + SSH helper**：新增 `fs.remove` 操作（`{ path, cwd?, recursive?, policy }`），helper 侧调用其 `ctx.fs.remove`，错误码经 `errorCodes` 表透传（含 `FS_NOT_EMPTY`）。
- **`fs-sftp`（fork）**：`conn.sftp.remove(target, { recursive })`；围栏同样落在父目录规范化路径上（远端 `pwd -P` 探测），未带 `recursive` 时先用 `sftp.list` 判空。
- **`workspaceFiles.delete`**：`lstat` 检查存在性 → 在**父目录**上证明工作区包含性（`confinePath`）→ 委托 `ctx.fs.remove` → 把 `FS_NOT_EMPTY` 映射为 `workspace-file/not-empty`。方法名是 `delete` 而非 `remove`：客户端命名空间服务自己占用 `remove` 作挂载生命周期方法，遮蔽它会以 `client api: method "workspaceFiles/remove" conflicts with its namespace service` 让整个 `@deepseek-ai/dsh-api-remotes` 客户端插件启动失败（见下方踩坑）。
- **`ui-sidebar-files`（上游包，fork 打补丁）**：行内删除控件（hover/聚焦显现）+ `Modal` 二次确认；确认前不发请求；成功后由 store 的 `removed` 动作丢掉该行、剪掉子树层与展开项，再重读父层；失败时弹窗保持打开并显示映射文案。`paths.ts` 抽出 `childPath`/`isUnder`（store 剪枝需要后者，避免 store↔face 循环导入）。

## 踩坑

- **Remote 方法名不能与命名空间服务同名**：`RemoteNamespaceService` 自己有 `remove(kind, method, token)` 生命周期方法，客户端 `validateContribution` 会拒绝同名 Remote 方法；失败表现是「web boot: N entries did not activate / `@deepseek-ai/dsh-api-remotes`: failed」，且**没有任何控制台报错**（`assertEntriesActive` 只报 fiber 状态）。定位手法：`pnpm exec vitest run --config vitest.e2e.config.ts packages/api/remotes/tests/built-lib.e2e.ts` 会在普通 Node 里直接抛出真实错误。
- **改了 `@Remote` 方法名要重建两侧产物**：宿主侧的 `lib/typert.host.js`/`lib/typert.remote-client.d.ts` 由根 `tsdown --env.DSH_BUILD_FACE host` 生成；客户端 bundle（尤其 `packages/api/remotes/lib/client.js`，它内联了所有命名空间的描述符）必须 `pnpm run build:lib:client` 重建，否则浏览器里 `remote.workspaceFiles.delete` 不存在（表现为对话框一直转「正在删除…」而网络面板里根本没有请求）。
- **`fs-local` 的权限/I/O 分支在 Windows 上测不出来**：沿用 `listingIoError` 的写法加 `v8 ignore` 注释（POSIX 车道覆盖权限翻译）。
- **删除的围栏必须落在父目录**：把条目本身 `resolve()` 再删除，会删掉链接指向的文件——这是接缝里唯一必须按路径寻址的变更，别照抄 `writeText` 的形状。

## 验证

- 单元：`packages/fs/fs-local/tests/filesystem.spec.ts`（remove 组）、`packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts`（removal fencing 组）、`packages/ssh/ssh/tests/helper-runtime.spec.ts`、`packages/ssh/fs-ssh/tests/provider.spec.ts`、`packages/remote/fs-sftp/tests/fs-sftp.spec.ts`（POSIX，WSL 跑）、`packages/api/workspace-files/tests/delete.spec.ts`、`packages/client/ui-sidebar-files/tests/{face,store,files-body}.*.spec.*`。
- 覆盖率：`fs/fs`、`fs-local`、`fs-sandbox`、`workspace-files`、`ui-sidebar-files` 触及到的源码 100%（语句/分支/函数/行）。
- 手工（2026-09-18）：`pnpm dsh web` → 右侧栏「工作区文件」→ `tmp/del-demo`：删 `doomed.txt` 后行消失、磁盘文件消失、兄弟文件保留；删 `sub`（内含 `nested.txt`）后目录与内容一并消失，弹窗文案为「永久删除目录 sub 及其全部内容？此操作无法撤销。」。

## 关联页面

- 决策记录：[从右侧栏文件树删除工作区文件（Agent Note）](../../../.agents/notes/implemented/feature/2026-09-18-workspace-file-deletion.md)
- 界面归属与去重：[fork Web 面板](fork-web-panels.md)
- 上游文件树与文档编辑：[文档面板的编辑与保存](document-panel-editing.md)
- 远端 provider 与沙箱围栏差异：[远端工作区 provider](remote-workspace-providers.md)
- 相关包契约：`packages/fs/fs/README.md`、`packages/api/workspace-files/README.md`、`packages/client/ui-sidebar-files/README.md`
