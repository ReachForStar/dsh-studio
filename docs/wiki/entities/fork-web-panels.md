---
title: fork Web 面板（ui-polish 的 Git/LaTeX/SSH/画布标签页）
type: entity
tags: [客户端, ui-polish, git, latex, ssh, excalidraw, 路由, 去重]
created: 2026-09-18
updated: 2026-09-20
sources: []
status: active
---

# fork Web 面板（ui-polish 的 Git/LaTeX/SSH/画布标签页）

## 职责

`@reachforstar/dsh-client-ui-polish` 在会话视图（`conversation.view`）里注册四个标签页——**Git**、**LaTeX**、**画布**（Excalidraw）、**SSH/SFTP**，另有设置行（背景图 / 自动压缩阈值 / 模型费率卡）与统计浮层。这是 fork 自研的 Web 面板族。

文件浏览**不在**这里：右侧栏的内置「工作区文件」树（`ui-sidebar-files`）与文档预览面板负责浏览、预览与编辑，本包不再提供重复的文件标签页（2026-09-18 去重，见下）。LaTeX 面板自带项目文件树与编辑器，那是 TeX 项目工作流的一部分，不构成重复。

面板的宿主半边由 `src/index.ts` 注册在 `/git`、`/latex`、`/bg`、`/scene` 四个前缀路由上；`bg`、`scene` 服务背景图与画布场景文件。所有请求的 `cwd` 都要经 `workspaceCwdResolver` 解析：**已知工作区本身或其子树**被接受，其它路径回落到宿主进程 cwd。

## 背景图与透明（覆盖范围）

`BackgroundRuntime` 把用户选的背景图写进 `body` 的 `background-image`，并在 body 上打 `data-ds-bg-image`；`apply()` 里的 `AMBIENT_OVERRIDES` 样式表据此把页面底色 token 置透明，让图片透出来。**除画布面板外全页透明**（2026-09-20 扩范围）：

| token | 背景图激活时 | 理由 |
| --- | --- | --- |
| `--dsw-alias-bg-base` | transparent | 应用底色（外壳、对话区） |
| `--dsw-alias-bg-layer-1` | transparent | 一级抬升面（卡片、行） |
| `--dsw-alias-bg-layer-2` | transparent | 二级嵌套面 |
| `--dsw-specific-sidebar-fill` | transparent | 侧边栏与标题行 |
| `--dsw-alias-bg-overlay` | **保持不透明** | 菜单/弹窗浮在照片之上，透明会丢对比度 |

画布面板是唯一的例外：`[data-ui-polish-excalidraw]` 内部把上述抬升面 token 重新声明为 `var(--dsw-alias-bg-overlay)`，因为 Excalidraw 自绘画布背景（`viewBackgroundColor`），绘图面透明会破坏线条对比。排查经验：token 层改写无法“局部取消”，排除某个子树只能在该子树内用**未被改写的** token 重新声明。

## `/git` 路由

Git 面板按 `dsh-git-panel` 的交互重写（2026-09-19）：多仓库卡片、逐文件 diff 抽屉与图片并排对比、提交规则与生成模型、历史提交图、合并状态处理。

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `GET /git/repos` | GET `?cwd&refresh` | BFS 发现工作区内的仓库（含嵌套仓库与 worktree），带扫描缓存 |
| `GET /git/status` | GET `?cwd` | 分支、上游、领先/落后、porcelain 分组（staged/unstaged/untracked/conflicted）、合并状态 |
| `GET /git/log` | GET `?cwd&skip&limit&stat` | 提交元数据（可选 diffstat 总量） |
| `GET /git/branches` | GET `?cwd` | 本地分支、当前分支、上游 |
| `GET /git/show` `/git/blob` | GET `?cwd&ref&path` | 某版本的文本内容 / 原始 blob 字节（图片预览） |
| `GET /git/models` | GET | 生成提交信息可用的 provider/model 目录 |
| `GET /git/rules` | GET `?cwd&repo` | 生效的提交规则与其来源（仓库级 / 全局 / 内置） |
| `POST /git/stage` `/unstage` `/discard` `/clean` | POST `{cwd, paths}` | 索引与工作树变更 |
| `POST /git/diff` | POST `{cwd, path, staged, untracked}` | 单文件 diff（未跟踪文件由宿主合成） |
| `POST /git/commit` | POST `{cwd, message, paths, push}` | 提交指定路径，可选随后推送；合并进行中提交即完成合并 |
| `POST /git/undo-commit` | POST `{cwd}` | 软重置上一次提交 |
| `POST /git/push` `/pull` | POST `{cwd}` | 推送 / 抓取并合并上游 |
| `POST /git/switch` | POST `{cwd, branch, create}` | 切换或新建分支 |
| `POST /git/stash` | POST `{cwd, op}` | 列出 / 储藏 / 弹出储藏 |
| `POST /git/merge-abort` `/merge-complete` | POST `{cwd}` | 中止或完成进行中的合并 |
| `POST /git/reset` | POST `{cwd, mode}` | 软 / 混合 / 硬重置 |
| `POST /git/rules-save` `/rules-reset` | POST `{cwd, repo, scope, systemPrompt, userContext}` | 保存或清除提交规则（YAML 文件存于 `~/.dsh/git-panel/`） |
| `POST /git/generate` `/generate-cancel` | POST（NDJSON 流） | 按规则渲染提示词流式生成提交信息，或取消 |

提交规则用 `{repo_name}`/`{branch}`/`{file_list}`/`{staged_diff}` 四个占位符渲染；生成模型可选择并存入 `localStorage`。写操作记入审计日志（`audit()`）。

## LaTeX 面板

`latex` 标签页基于本机 TeX 发行版提供 Overleaf 式流程，宿主半边是 `src/latex-service.ts`，注册在 `/latex` 前缀上。路由、编译链路、安全边界与验证方式见 [LaTeX 面板](latex-panel.md)。

## 设计要点与边界

- **`/git/*` 与 `/latex/*` 不走 `ctx.fs` 接缝，也不走每次调用的沙箱策略**：守卫是 `resolveRepoPath` / `resolveProjectDir` / `resolveProjectPath`（拒绝 `..`、绝对路径与反斜杠，要求解析结果落在基准目录下）。因此换 fs provider（例如远端 SFTP 工作区）不会改变这些面板的行为，模型与面板看到的文件也可能不同源。
- **Git 面板覆盖工作区内的每个仓库**：`/git/repos` 逐层扫描（跳过 `node_modules`/`.git` 等），每张卡片以自身路径作为 `cwd` 查询，合并状态经 `git rev-parse --absolute-git-dir` 探测，避免嵌套仓库读到宿主仓库的元数据。
- **图片 diff**：`imageMimeOf` 判定扩展名，旧版本走 `/git/blob`，新版本走工作树读取，并排显示，点击进入全屏（`←/→` 切换新旧）。
- 画布把场景写进 `<workspace>/.dsh/excalidraw/scene.json`，与模型侧 `excalidraw_*` 工具读写同一文件，靠指纹轮询同步。
- 面板与生成功能的 LLM 路由共用 `src/llm-route.ts`。

## 文件面板去重（2026-09-18）

fork 的「文件」标签页（`MutationDiffPanel`，id `files`）与右侧栏「工作区文件」树重复：同一批文件、两棵目录树、两个编辑器。按用户要求**保留右侧栏（上游）而删除顶部标签页**：`MutationDiffPanel` 与其样式、`diff.*` 文案、只服务于它的 `/git/list` 与同日加入的 `/git/delete` 一并移除（含对应测试），slot 注册改为 `git`/`latex`/`excalidraw`/`ssh`。删除能力随后补到了存留的那棵树上（`ctx.fs.remove` → `workspaceFiles.delete` → 行内删除按钮），见 [工作区文件删除](workspace-file-deletion.md)。决策记录见 [移除重复的文件面板（Agent Note）](../../../.agents/notes/implemented/simplification/2026-09-18-remove-duplicate-file-panel.md)。

## 踩坑

- **改了客户端源码必须重建产物**：`dsh web` 服务的是 `lib/client.js`。`pnpm exec tsc -b packages/client/ui-polish/tsconfig.json` 后再在该包内 `pnpm exec tsdown --env.DSH_BUILD_FACE client`（host 半边也在这条命令里一起产出），否则浏览器看到的还是旧面板（本轮去重若只改源码，标签页不会消失）。
- **改 host 半边要重启 `dsh web`**：host 走源码 tsx 启动，运行期不会热载入。
- **`slot-catalog.ts` 是生成物**：增删 slot 注册后要跑 `pnpm run gen-client-catalog`，否则 `verify-client-catalog` 报 stale。
- 本轮重写暴露的六个缺陷（渲染误判、嵌套仓库状态错位、LaTeX 路径基准等）见 [Git/LaTeX 面板重写的缺陷与修复](../queries/ui-polish-git-latex-defects.md)。

## 验证

- 面板与路由：`tests/apply.client.spec.ts`（slot 注册与卸载）、`tests/git-service.host.spec.ts`（路由分发、cwd 解析、路径校验、状态分组、集合合并状态、生成流）、`tests/latex-service.host.spec.ts`、`tests/ssh-panel.client.spec.tsx`、`tests/excalidraw-service.host.spec.ts`。
- 手工：`pnpm dsh web` 顶部标签环为 对话 / 轨迹 / Git / 画布 / LaTeX / SSH（无「文件」）；2026-09-19 逐项验证了 Git 多仓库卡片、图片 diff 与全屏、规则编辑器、模型弹窗、生成三态、冲突条与完成合并，以及 LaTeX 的读取、保存后自动编译、PDF 预览、新建空文件、字体弹窗、AI 写作。

## 关联页面

- 决策记录：[移除重复的文件面板（Agent Note）](../../../.agents/notes/implemented/simplification/2026-09-18-remove-duplicate-file-panel.md)
- LaTeX 面板：[LaTeX 面板](latex-panel.md)
- 上游文件树与文档编辑：[文档面板的编辑与保存](document-panel-editing.md)
- 远端工作区对 fs 接缝的影响：[远端工作区 provider](remote-workspace-providers.md)
- 面板包契约：`packages/client/ui-polish/README.md`
