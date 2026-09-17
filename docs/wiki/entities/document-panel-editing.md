---
title: 文档面板的编辑与保存（workspaceFiles.write）
type: entity
tags: [客户端, 文件面板, 写接口, 版本守卫]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: active
---

# 文档面板的编辑与保存（workspaceFiles.write）

官方文件面板（`packages/client/ui-sidebar-documentpreview`）在 fork 中补上了「编辑并保存」。设计取舍见 [Agent Note](../../../.agents/notes/implemented/feature/2026-09-17-workspace-file-editing.md)。

## 关键文件

| 位置 | 职责 |
| --- | --- |
| `packages/api/workspace-files/src/index.ts` | `@Remote write(scope, path, text, guard, signal)`；`locateWritable` = `locateFile` + 工作区包含性；`maxFileBytes` 上限；`FS_STALE_VERSION` → `workspace-file/stale-version` |
| `packages/api/workspace-files/src/types.ts` | `WorkspaceFileWriteGuard`、错误码 `workspace-file/stale-version` |
| `packages/client/ui-sidebar-documentpreview/src/client/rpc.ts` | `WriteWorkspaceFile`、`createWriteFile`（`expectedVersion` 转成守卫对象） |
| `…/src/client/face.ts` | `save(tabId, file, text, expectedVersion, signal)`；结算规则与读取一致（tab 结束/读取代际前移则不落状态） |
| `…/src/client/store.ts` | `writing` / `writeFailure`；`written` 同时推进 `version` 与 `observedVersion` |
| `…/src/client/TextPreview.tsx` | pane 级编辑器：整文件读完才可编辑、`baseline` 判定脏标记、`Ctrl/Cmd+S`、`Esc`、状态行 |

## 设计要点

- **编辑器放在 pane 而非各渲染器**：纯文本/代码/Markdown 共用一个保存路径，版本守卫只需正确一次。
- **必须先读完整文件**：保存是整文件替换，取自已加载前缀的草稿会把文件截断；打开编辑器时自动续读直到 `eof`。
- **版本守卫**：用 `current.version` 作 `expectedVersion` → `fs.writeText` 的 `replaceIfVersion`；文件在读取后被改动则报 `workspace-file/stale-version`，前端显示「文件已被外部修改，请重新载入后再保存」，草稿保留。
- **写入限制在工作区内**：读取允许工作区外路径（预览他人文件仍是预览），写入不允许（`workspace-file/outside-workspace`）。
- **自身的写入不算外部变更**：提交后把 tab 的 `version`/`observedVersion` 一起推进，避免变更提示条把自己的保存报成外部改动。
- **脏标记用基线文本而非标志位**：`baseline` 在草稿初始化与写入成功时更新；打开又关闭而不改动不会误报未保存。

## 踩坑

- **客户端 Remote 类型来自构建产物**：`@deepseek-ai/dsh-api-workspace-files/remote` 指向 `lib/typert.remote-client.d.ts`，由 Typert 生成器在**根构建**（`pnpm run build:lib:host` / 根 `tsdown --env.DSH_BUILD_FACE host`）时产出。新增 `@Remote` 方法后若不重建，客户端会报 `Property 'write' is missing`——**单包 `pnpm --filter <pkg> run bundle` 不会重生成**。
- **测试目录不在包 tsconfig 内**：`tsc -b packages/<pkg>/tsconfig.json` 不检查 `tests/`，漏掉的类型错误只会在推送前的 `tsc -b tsconfig.client.json`（或 CI）暴露。

## 二进制写入（writeBytes）

office 文档是 zip，因此写入链路是独立的一条：

- `packages/fs/fs`：`FileSystem.writeBytes` 是**具体方法**，默认以 `FS_UNSUPPORTED_BINARY_WRITE` 拒绝——纯文本通道的后端必须明说，而不是写坏文件；`FsWriteBytesOutcome` 只带 `operation` 与 `version`（字节没有 diff 基准）。
- `fs-local`：`writeFileAtomic` 接受 `string | Uint8Array`，`writeBytes` 复用与 `writeText` 相同的守卫与锁。
- `fs-sandbox`：同一个 `checkedTarget` 围栏。
- `fs-ssh`：继承拒绝（helper 通道是文本），并把错误码列入透传名单。
- `workspaceFiles.writeBytes`：base64 传输 + 工作区包含性 + `maxFileBytes` + 版本守卫；拒绝映射为 `workspace-file/binary-unsupported`。
- 客户端：`rpc.createWriteFileBytes` → `face.saveBytes` → pane 通过 slot owner props 透出 `saveBytes`/`saving`/`saveFailure`。

## office 渲染器

- `src/client/office/{zip,xml,errors}.ts` + `OfficeBody.tsx`：zip 读写（`fflate`）、按**局部名**匹配 XML（忽略生产者前缀）、文本叶子替换（首个叶子取新文本、其余清空并打上 `xml:space="preserve"`）、共享编辑外壳。
- `office/docx.ts`：解析 `word/document.xml` 为段落文本，返回的 `rebuild` 闭包持有全部部件，因此写回不会丢掉读取器不认识的内容。
- `office/pptx.ts`：按编号顺序解析 `ppt/slides/slideN.xml`，每张幻灯片一组文本叶子。
- `src/client/{docx,pptx}/`：注册为 `bytes-complete` 内置渲染器；编辑为**文本级**，版式/表格/图片/新增形状不在范围。
- 视频渲染器（`src/client/video/`）：`<video controls preload="metadata" playsinline>`，mp4/m4v/webm/ogv/mov。

## 已知待办

- 字节模式查看器（PDF/HTML/图片）保持只读；`.doc`/`.ppt` 等解析不了的格式显示「无法打开」。
