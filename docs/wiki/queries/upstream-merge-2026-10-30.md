---
title: 合并上游 upstream/master（2026-10-30）
type: query
tags: [upstream-sync, merge, 冲突取舍, fs 接缝, ui-sidebar-files, 工具一致性, 生成物]
created: 2026-10-30
updated: 2026-10-30
sources: []
status: active
---

# 合并上游 upstream/master（2026-10-30）

## 问题

把上游 `upstream/master` 自上一轮基点起的 351 个提交并入 fork 的 `develop`（fork 侧同期 309 个提交）。冲突 **67 个文件**，其中 6 个是「fork 已删除、上游修改」的工作流与脚本，11 个是双语配对与文档生成物。

上游本轮的主要改动面：

- **`ctx.fs` 接缝新增三个必要成员**：`patchText`（解析后的 hunk）、`deleteFile`（按已解析目标删普通文件，带版本守卫）、`moveFile`（双端加锁、按需打补丁、发布后删源）。`FsErrorCode` 从手写联合改为 `FS_ERROR_CODES` 常量数组派生，新增 `FS_PATCH_MISMATCH`、`FS_SAME_TARGET`。
- **`ui-sidebar-files` 整体重写**：状态从「每 tab 一棵树」改为「每分栏一棵树」（`byPane`），目录树抽出受控工厂 `sidebar.files.tree`（含 `accessory` 槽与 `rowTriggerProps` 右键菜单）、新增 `FileNavigator`/`FileTree`/`NavigatorToggle`/`workspace-tree.ts`，`face.ts` 变成按分栏的生命周期（`attach`/`hold`/`navigatorDrawn`）。
- **新增 SDK/Desktop 工具一致性门禁**（`apps/cli/tests/profiles/sdk/tool-parity.ts`）：真实启动两个 profile 比对模型可见工具集，差异必须逐条登记理由，未使用的登记同样失败。

## 取舍（沿用按来源策略）

| 类别 | 处理 |
| --- | --- |
| fork 已删除的云端 CI 与发布工作流 | `.github/workflows/{build-exe-for-python-sdk,ci-master,release-publish}.yml`、`scripts/ci-workflow.spec.ts`、`scripts/tests/ci-{master-platforms,release-selfhosted}.spec.ts` 维持删除（上游本轮仍在改它们） |
| 上游删除的包 | `packages/client/ui-deepseek-model-label-1017` 随上游删除；本机构建残留目录（只有 `lib/` 与 `node_modules/`，无跟踪文件）已核对后清除，否则 `constraints` 报「expected a package here」 |
| 生成物 | `docs/{capability-seams,event-producer-consumer,tool-catalog,persistence-schema.json,persistence-catalog,config-catalog,subsystems/*}`、`slot-catalog.ts`、`api-catalog.ts`、`pnpm-lock.yaml` 取上游后重生成；`pnpm-lock.yaml` 用 `--no-frozen-lockfile` 重新解析（上游把 `lefthook` 提到 `^2.1.14`） |
| fork 与上游同时改的源码 | `TextPreview.tsx`、`ToolCallTree.tsx`、`ui-chat` 的 `ChatView/ChatFlow/ChatNodeSeat/slots.ts`、`ui-conversation/locales.ts`、fs 三包与 `fs-ssh`、`ssh/schemas.ts`、`llm-pi-ai`、`tsconfig.host.json`、`.gitignore`、两个 `package.json` 逐块合并 |

逐块合并的要点：

- **`ui-chat`**：上游把 `fileMentions` 从 owner props 移到 node renderer 注入，因此 fork 的四层传递链（`ChatView` → `ChatFlow` → `ChatNodeSeat` → `AssistantNodeView`）中的 `fileMentions` 全部删除，保留 fork 的 `openView`（「打开视图」按钮）与上游新增的 `resolveFilePath`/`useContextMenu`。
- **`ui-tool`**：上游用 `renderFallback` 取代了 fork 向下传 `t` 的做法，`ToolCall`/`ToolCallBranch` 的 `t` 一并移除，`openView` 保留。
- **`llm-pi-ai`**：fork 的 `discoverEndpointCatalog` 与上游的 `prepareHeaders` 是不同键，两者并存。
- **`tsconfig.host.json`**：保留 fork 的根 `tests/**/*.spec.ts` 声明，并加入上游的 `apps/web/tests/sidebar-drawer.e2e.ts`。

## fork 自研面在上游新结构上的重建

### `ui-sidebar-files`：每行删除控件与确认弹窗

上游重写后 fork 的删除能力按新结构重建：

| 层 | 落点 |
| --- | --- |
| 行控件 | `FileTree.tsx` 新增可选 `onDelete(entry, kind)`；文件与目录行在既有 `.row` 内、`accessory` 之前渲染 `IconTrashOutlineRegular` 按钮（`css.rowDelete` 在悬停或按钮持有焦点时才显现），`data-files-delete=<kind>` 供测试定位 |
| 确认与失败文案 | `FileNavigator.tsx` 持有 `pending`/`removing`/`removeFailure` 状态并渲染 `Modal`；`removalFailureLine()` 按 `workspace-file/not-empty`、`not-found`、`outside-workspace` 各给一行，其余按传输层消息 |
| 状态 | `store.ts` 新增按分栏的 `removed(paneId, parent, name)`：过滤该层条目、剪掉被删路径的子树层与展开项；`paths.ts` 的 `childPath`/`isUnder` 取代 `store.ts` 内联的 `startsWith` 判子树 |
| Remote 绑定 | `face.ts` 新增 `DeleteWorkspaceEntry`、`WorkspaceFilesDeleteRemote`、`createDelete()` 与 `FilesInjected.deleteEntry(paneId, …)`；`index.ts` 把 `createDelete(ctx.remote)` 传给 `filesFace` |
| 文案 | `locales.ts` 补 11 个 `delete.*` 键 × 8 语言（`pt` 是上游新增语言，本轮一并补） |

### `fs-sftp`：补齐 `patchText` / `deleteFile` / `moveFile`

上游把三个成员设为必需，fork 的 SFTP provider 必须实现：

- `patchText`：`applyHunksOrThrow` 之后按源文件行尾风格写回，守卫失败报 `FS_STALE_VERSION`、hunk 不匹配报 `FS_PATCH_MISMATCH`。
- `deleteFile`：只删普通文件，先取有界基线再 `sftp.remove`。
- `moveFile`：两端按字典序嵌套加锁，目标守卫（`createIfAbsent` / `replaceIfVersion`）在发布前检查，发布后删源；删源失败返回 `sourceDeleted: false` 与 `sourceFailure`。

三处重复因此顺手收敛：hunk 应用提取为 `@deepseek-ai/dsh-fs` 的新导出 `applyPatchOrThrow`（`fs-local` 与 `fs-sftp` 共用，原来两侧各有一份私有 `patchContent`）；`fs-sftp` 内部抽出 `checkedFile` / `readEditable` / `mutateText`，`editText` 与 `patchText` 只保留各自的文本变换。

## 合并引入的缺陷（均已修复）

1. **`TextPreview.tsx` 工具栏出现两份 reload 与 autoRefresh**：合并 `tools` 列表时把 fork 侧被上游取代的公共控件（自动刷新开关、`jscpd:ignore-start` 段与 reload 按钮）一起复制进 `PreviewFrame` 的 `tools`，`document-toolbar`/`renderer-loading`/`text-preview` 三个 spec 以「找到多个 reload 按钮」失败。修法：删除复制的公共控件，只留 fork 的编辑/保存按钮，并把编辑状态条放回 `children` 开头（保持工具栏下方、正文上方的原位置）。
2. **SDK/Desktop 工具一致性门禁缺 fork 差异登记**：`desktop-tools.expected.e2e.ts` 4 项失败，报 SDK 独有 12 个 ssh/sftp 工具、Desktop 独有 4 个 excalidraw 工具。按该门禁的设计，用 `toolParityExceptions` 逐条登记（`standard` 含 canvas 4 条 + sdk 12 条，`ptc` 含 sdk 12 条），理由用两条共享常量（画布随图形客户端、ssh/sftp 随远端工作区 profile）。
3. **`scripts/cua-helper/payload.spec.ts` 假设云端发布工作流存在**：该 spec 读 `.github/workflows/release-publish.yml` 与 `release.yml`，两者在 fork 已按策略删除。改为断言「两者都不存在」，保留对 `cua-helper-package.yml` 的检查。
4. **`scripts/verify-repository-references.ts` 的 `generatedLockfiles` 排除与上游 spec 冲突**：上游删除了对 `python/sdk/uv.lock` 的排除，spec 断言该文件仍应被检查（含注释行的 commit 与组织 URL），fork 侧的排除让该断言返回空。跟随上游删除排除后 spec 两项通过。
5. **`scripts/rescope-vendor.ts` 的 postcondition 文本落伍**：上游把 `vendor/README.md` 的改动清单从编号列表改成 `- **V17 · `@deepseek-ai` rescope**` 形式，脚本仍期望 `17. **…**`，`rescope-vendor:check` 报 0 次出现。修法：postcondition 跟随新写法。
6. **`packages/bundle/web-app/package.json` 的 `files` 顺序**：把 fork 的 `presets/{xingchen-qiming,pi}.patch.yml` 放回 presets 块内（`constraints` 要求与目录一致）。
7. **中文侧文档落后**：`docs/tool-catalog.zh.md` 缺 fork 三个工具包（`tool-ssh` 12 个、`tool-excalidraw` 4 个、`tool-a2a` 2 个）的映射表行与章节，`verify-md-links` 因此报锚点缺失、配对门禁报标题数 134 对 113。按英文结构补 3 行表格 + 18 个工具节（正文翻译、JSON Schema 与 Source 行原样），随后 `verify-translation-pairing --write --all` 重录 10 个配对记录。

## 验证结果

环境：Node `v24.22.2`（nvm）、git `2.56.0`（`/home/asus/envs/git-new/bin`，系统 git 2.34.1 缺 `worktree list -z`）、`LC_ALL=C`。

- `pnpm run typecheck` 5 门、`pnpm run build` 10 门、`pnpm run doc-sync` 43 门、`pnpm run test:docs` 21 门全过。
- `verify-translation-pairing`：1205 对全部一致；`verify-persistence-changes`：67 根匹配 22 条记录（无需补记）。
- 定向包测试：`ui-sidebar-files` 200 项、`ui-sidebar-documentpreview` 670 项、`fs/* + ssh + fs-sftp` 915 项、`worktree` 53 项全过。
- `pnpm run test`（全量 53779 项）：72 项失败，逐项归类后无合并引入者——
  - 34 项为上轮已记录的基线失败（`fork-delivery` 14、`subagent-pi` 9、`core/agent` 3、`locale-dictionary-parity` 2、`vfs-example-fixture` 2、`webworker-packer/preview` 1、`ui-theme/hover-styles` 1、桌面强制更新策略 2）。
  - `worktree` 6 + `checkout-safety` 1：系统 git 2.34.1 不认 `-z`；换 git 2.56 后全过。
  - `client-ui-forge` 1、`workspace-changes` 2、`ptc-runtime-node` 1、`binary-rpc` 1、`plugin-manager` 1：5 秒用例预算在满载并发下超时；隔离或 `--testTimeout=30000` 下全过（`client-ui-forge` 118 项通过）。
  - `persistence-epoch-header` 1：并发下 glob 到已删除的 `oxlint-contract-*.ts` 临时文件；隔离运行通过。
- `pnpm run test:expected`：144 项剩 1 项失败，即上轮已记录的 `apps/cli` `subagent-inheritance`（fork 自研 ssh/sftp/a2a 工具不在记录的期望里）。
- `pnpm run test:snapshot`：4 个文件 208 项失败（上一轮同 4 个文件 199 项），仍属[会话格式 v5](session-format-v5-landing.md)记下的「按 v5 写入器全量刷新并评审」遗留；差异形态为工具集与工具结果记录的漂移。
- `pnpm run lint`：75 条既有红项，本轮改动的文件无红项（合并后新增的两条行超长已修）。
- `pnpm run duplication`：75 个克隆；本轮新增的 `fs-sftp` 三方法曾与 `fs-local` 的同名实现、以及与 `editText` 的入口守卫重复，提取共享 helper 后剩余克隆都是合并前既有的形态（`readBytes`/`readByteRange`、`writeText`/`writeBytes`、`fs-sandbox` 与 `fs-sftp` 的 `checkedTarget`）。
- `pnpm run hygiene`：12 门失败，全部为 fork 既有债务或上游 `publint` 现状，清单见 [fork 自研包的门禁红项清单](fork-gate-debt.md) 的 2026-10-30 段。

## 与既有知识的关系

- 沿用 [合并上游决策](../decisions/2026-09-upstream-sync.md) 的按来源取舍与生成物重生成；本轮新增的判定见该页「后续轮次：2026-10-30」。
- 删除能力的新落点见 [工作区文件删除](../entities/workspace-file-deletion.md)；SFTP provider 的三个新成员见 [远端工作区 provider](../entities/remote-workspace-providers.md)。
- 与上一轮同属「上游给核心接口加必需成员，fork 自研面必须跟着补」的形态：上轮是 LiveShare 端点全覆盖表，本轮是 `ctx.fs` 的三个新抽象成员与新增的工具一致性门禁。

## 存疑或待跟进

- 上游 `publint` 现状：`pnpm run publint` 对大量上游包（`a2a`、`acp`、`api/*`）报 `exports["./src/*"]` 与 `files` 不匹配，与 fork 无关，需要上游侧确认该门禁在 master 上的预期状态。
- fork 自研包的 `locale/en.json` 全线缺失（`verify-locale-metadata` 报 16 个包），客户端文案仍有硬编码（`CuaDriverInstall.tsx` 的 `HTTP`/`Exit code`/`Unknown error`、`ui-polish` 的两个 `argsSummary` 返回值），绝对路由两条（`CuaDriverInstall.tsx`、`ui-polish/SshPanel.tsx`）——都是本轮新门禁抓出的既有债务。
- `verify-product-use`/`verify-runtime-closure`/`verify-cordis-config`/`verify-default-product-isolation`/`constraints`/`verify-package-dependencies` 的 fork 红项与上一轮所列相同，未扩大也未清偿。
- 快照道 4 个文件、208 项失败仍需单独一轮「按 v5 写入器全量刷新并评审」。
