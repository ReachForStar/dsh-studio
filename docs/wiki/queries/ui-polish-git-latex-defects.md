---
title: Git/LaTeX 面板重写的缺陷与修复（2026-09-19）
type: query
tags: [ui-polish, git, latex, bug-fix, 多仓库, 合并状态]
created: 2026-09-19
updated: 2026-09-19
sources: []
status: active
---

# Git/LaTeX 面板重写的缺陷与修复（2026-09-19）

## 问题

Git 面板按 `dsh-git-panel` 重写、LaTeX 面板新增后，浏览器逐项验证暴露出六个缺陷：两个渲染/状态误判、一个多仓库解析错误、三个 LaTeX 路由与模型路由缺陷。全部已在本次修复并补测试。

## 缺陷与解法

### 1. 加载中误显示“合并进行中”

- 现象：面板刚打开、`status` 尚未返回时，每张仓库卡片都显示合并徽标与“中止合并”。
- 根因：渲染条件是 `s?.mergeState !== null`；`s === null` 时可选链给出 `undefined`，而 `undefined !== null` 为真。
- 修复：改为 `s !== null && s.mergeState !== null`（`GitPanel.tsx`）。

### 2. 嵌套仓库的合并状态读错仓库

- 现象：工作区内的第二个仓库处于 merge 冲突时，`/git/status` 返回 `mergeState: null`（冲突文件却正常列出）。
- 根因：`detectMergeState` 用 `git rev-parse --git-dir`，子目录仓库返回的是相对路径 `.git`，`existsSync(join('.git','MERGE_HEAD'))` 相对**宿主进程 cwd** 解析，实际探测的是宿主仓库。
- 修复：改用 `git rev-parse --absolute-git-dir`；补测试在临时仓库里真造一次 merge 冲突，断言 `mergeState === 'merge'` 与 `conflicted` 列表。

### 3. 多仓库发现与 cwd 解析不一致

- 现象：`/git/repos` 发现两个仓库，但第二张卡片显示的分支、文件数、日志全是宿主仓库的数据（分支名显示为宿主分支，改动列表完全重复）。
- 根因：`workspaceCwdResolver` 只接受与已知工作区路径**精确相等**的 `cwd`，其余一律回落到宿主进程 cwd；`RepoCard` 传的是 `repo.path`（嵌套仓库路径），于是每次请求都落到宿主仓库。
- 修复：解析器放宽为“已知工作区本身**或其子树**”，其它路径仍回落；同时补 resolver 单测（`D:/repo-a/nested/sub` 被接受，`D:/repo-ab` 不被误认）。

### 4. LaTeX 文件读写用了错误的路径基准

- 现象：打开子目录项目时编辑器报 `ENOENT ... D:\deepseek-harness\chapters\intro.tex`。
- 根因：`/latex/list` 返回项目相对路径，而 `/latex/read`、`/latex/write` 只有 `path` 且按工作区根解析；`/latex/ai` 却已带 `dir`。
- 修复：两个路由都接收 `dir` 并按项目目录解析 `path`，与 `ai` 的语义统一；客户端 `read`/`write` 同步带 `dir`，测试改为“workspace 根 + `dir: 'rw'`”并断言读写往返。

### 5. 新建空文件被服务端拒绝

- 现象：点“新建文件”后报 `latex panel: body field "content" must be a non-empty string`，磁盘无文件。
- 根因：`/latex/write` 用 `bodyString` 取 `content`，要求非空；新建文件天然传空串。
- 修复：新增 `bodyText`（只要求是字符串，允许空串）用于 `content`；测试覆盖“写空文件 → 读回空串”。

### 6. AI 写作在默认 provider 无凭证时静默空结果

- 现象：本机只配了 amax 凭证，点“AI 写作”0.08 秒返回 `latex panel: the model returned an empty result`。
- 根因：写作助手按“第一个有模型的 provider”路由，选中了 `deepseek-official`（模型目录存在但无凭证），流立即结束。
- 修复：抽出共享模块 `src/llm-route.ts`（`listLlmModels` / `resolveLlmRoute`），Git 面板的提交信息生成与 LaTeX 写作共用；新增 `GET /latex/models` 与 AI 弹窗的模型下拉（选择存 `localStorage` 的 `dsh-latex-ai-model`），用户可切到有凭证的 provider。

## 复发预防

- **可选链 + `!== null` 是危险组合**：`x?.y !== null` 在 `x` 为空时恒真。判空与属性判断要分成两个条件。
- **相对路径的 git 元数据探测**：`--git-dir` 只保证相对当前仓库，任何 `existsSync(join(gitDir, ...))` 都必须先 `--absolute-git-dir`，否则嵌套仓库/子目录场景会读到宿主仓库。
- **cwd 解析器的语义要与发现逻辑对齐**：`/git/repos` 能发现嵌套仓库，解析器就必须接受其路径，否则失败是静默的（回落到别的仓库，显示错误数据）。
- **同一面板内的路由要保持同一路径基准**：`dir` + 项目相对 `path` 是三处路由的统一约定。
- **写接口要区分“必填”和“可空”**：`bodyString` 与 `bodyText` 各司其职。
- **LLM 功能要有模型选择入口**：模型目录存在不代表凭证可用，默认路由不能是唯一路径。

## 涉及模块

- `packages/client/ui-polish/src/git-service.ts`、`src/git-llm.ts`、`src/llm-route.ts`、`src/latex-service.ts`
- `packages/client/ui-polish/src/client/{GitPanel.tsx,LatexPanel.tsx,latex-client.ts}`
- 测试：`tests/git-service.host.spec.ts`、`tests/latex-service.host.spec.ts`
