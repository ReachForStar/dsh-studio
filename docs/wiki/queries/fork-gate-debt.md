---
title: fork 自研包的门禁红项清单
type: query
tags: [gates, doc-sync, lint, coverage, constraints, fork, 待办]
created: 2026-09-18
updated: 2026-09-19
sources: []
status: active
---

# fork 自研包的门禁红项清单

## 问题

fork 自研包（`packages/remote/*`、`packages/a2a/*`、`packages/core/pi-agent-loop`、`packages/fs/tool-excalidraw` 等）在上游门禁上留下成片红项。fork 自己的 `.github/workflows/` 只有 6 个非测试型工作流（build-preview-cloudflare / expected-filenames / issue-policy / landlock-run / node-addon-system / weighted-approval），**不跑** `doc-sync`、`lint`、`constraints`、`test:coverage`，所以这些红项只会在本地手动执行门禁时暴露。2026-09-18 执行 `pnpm run doc-sync`（31 通过 / 10 失败）、`pnpm run lint`（18 处）、`pnpm run constraints`、`pnpm run verify-package-dependencies` 后盘点如下（已随本批修掉的除外）。

## 红项与修复方向

| 门禁 | 报错 | 归属 | 修复方向 |
| --- | --- | --- | --- |
| ~~`verify-doc-graphs`、`verify-cordis-catalog`~~ **已清偿（2026-09-18 A2A 文档批）** | 服务签名引用未分类类型：A2A 六个类型、`FsWriteBytesOutcome`、`WorkspaceFileWriteGuard` | A2A 批 + office 批 | — |
| ~~`verify-subsystem-pages`（A2A 组 README）~~ **已清偿（2026-09-18 A2A 文档批）** | `packages/a2a/README.md: package group has no group README` | A2A 批 | — |
| ~~`verify-tool-catalog`~~ **已清偿（2026-09-18 A2A 文档批）** | `tool-a2a` 未登记进 `TOOL_PACKAGES` | A2A 批 | — |
| `verify-config-catalog` | `pi-agent-loop` 约 16 处配置字段缺 JSDoc 散文（`a2a-host` 的 5 处已清偿） | pi 后端批 | 给每个 `Config` 字段补一句用途说明 |
| `verify-client-catalog` | ~~`slot-catalog.ts` 过期~~ **已清偿（2026-09-18 文件面板去重批）** | office 批 | — |
| ~~`verify-persistence-catalog`~~ **已清偿（2026-09-19 星域批）**；`verify-persistence-changes` 仍红 | `docs/persistence-{catalog,schema}` 过期（跑生成器即绿）；`SessionHeader.backend` / `JsonlHeaderLine.backend` 新增可选字段未确认 | 会话 v3 `backend` 字段批 | 生成物已重跑；确认记录需按 [persistence 变更流程](../../../docs/cookbook/reviewing-persistence-type-changes.md) 写入并处理版本决定 |
| `verify-config-source-ownership` | `packages/bundle/web-app/cordis.patch.yml:289` 内联 `apiKey: !!js process.env.DSH_A2A_API_KEY` | A2A 批 | 让 `dsh-a2a-host` 接受 `apiKeyEnv` 并经 `ctx.credentials`/环境快照解析，patch 只写变量名（与 `llm-*` 的 `apiKeyEnv` 同型） |
| `pnpm run lint` | `tool-excalidraw`：src 的 `no-base-to-string`/`no-unnecessary-type-assertion`，tests 的 `no-unsafe-*`（excalidraw 场景 API 是 `any`） | excalidraw 批 | 给场景元素补类型（或 `unknown` + 收窄），测试用类型化 fixture |
| `pnpm run lint` | `pi-agent-loop/src/agent.ts` 调已弃用的 `snapshotEvents`；`tests/translator.spec.ts` 多余类型断言 | pi 后端批 | 迁到同步读取的替代 API；删掉多余断言 |
| `pnpm run constraints` | `dsh-a2a{,-host}`、`dsh-tool-a2a` 的 `repository` 应为 `git+https://github.com/deepseek-ai/deepseek-harness.git` + 对应 `directory`；`dsh-pi-agent-loop` 版本须与根 `0.1.6-alpha.1` 一致 | A2A / pi 批 | 直接改 manifest |
| ~~`verify-package-dependencies`~~ **已清偿（2026-09-19）** | `workspace-files` 引 `FsVersion`、`ui-polish` 引 `tool-excalidraw#sanitizeScene`/`SCENE_RELATIVE`、`home-paths#dshHomePath`、`dsh-llm#BlockAssembler`/`createUserMessage` 未分类；另有四个客户端包的非 cordis `peerDependencies` 分区不符 | office / excalidraw / ui-polish 批 | — |
| `verify-package-dependencies`（新红项，2026-09-19 复检） | `ui-polish/src/latex-service.ts` 引 `@deepseek-ai/dsh-llm#createAssistantMessage` 未分类 | LaTeX 写作批 | 分类表写明「新增条目默认禁止、自动化代理不得添加」，需人工评审后登记 |
| ~~`verify-client-ui-i18n`~~ **已清偿（2026-09-19 ui-polish 批）** | 硬编码 UI 文案：`ui-polish` 的 `CompactionRow`（`80%（默认）`）、`GitPanel` 状态字母（`U`）与 diff 抽屉版本标记、`LatexPanel` 的 `Ctrl+S` 与 TeX 包名 | ui-polish 批 | — |
| `test:coverage` per-file 100% | 实测：`a2a/src/{index,client,server,task-store}.ts` 82–98%、`a2a-host/src/{index,executor}.ts` 82–96%、`tool-a2a/src/index.ts` 83%、`remote/fs-sftp/src/index.ts` 73.8% 语句 / 62.9% 分支、`remote/subprocess-sftp/src/index.ts` 80.8% / 65.4% | 各 fork 批 | 逐文件补分支与错误路径测试（远端 shell 探测失败、abort、符号链接、并发创建等） |

## 本批（2026-09-18 远端工作区）已修掉的红项

- `verify-export-jsdoc`：全仓库通过（补了 a2a、office、pi-agent-loop、fs `text.ts`、两个新 provider 的 JSDoc/@param/@returns）。
- `verify-doc-graphs` 的解析期两类报错：`A2AHostService.store` 缺显式类型、`TaskStore.list` 默认参数缺显式类型（typert 分析要求公开成员显式标注）。
- `pnpm run lint` 中本批新增的 `sonarjs(no-identical-functions)`：`remote/ssh/tests/stub-service.ts` 的两个会话 stub 抽出共享基类 `StubSession`。
- `test:docs`（doc-quick）20/20、`pnpm run typecheck` 全通过。
- `verify-config-catalog` 的 `a2a-host` 部分（2026-09-18 A2A 文档批清偿）：`Config.card` 的五个字段补 JSDoc；余下 `pi-agent-loop` 的 ~16 处仍欠。
- `verify-client-catalog`（2026-09-18 文件面板去重时清偿）：`slot-catalog.ts` 从 office 批起就过期（缺 `DocxBody`/`PptxBody` 等渲染器、多出已删除的 `MutationDiffPanel`），已跑 `pnpm run gen-client-catalog` 提交生成物。
- **客户端 bundle 无 Node builtin 门禁**（已补）：动态 bundle 的 factory 序言里出现 Node builtin 时，构建与服务都通过，直到浏览器启动才变成「entry did not activate / import failed」。2026-09-18 在 `packages/client/tsdown.client.ts` 加 `dsh-client-prologue-builtins`（序言 require 到 Node builtin 即构建失败）；`fflate` 默认解析到 Node 版是首个实例。
- **`verify-package-dependencies`**（2026-09-19 清偿）：六个运行时导出登记进 `SAFE_HOST_DEPENDENCY_EXPORTS`（`dsh-home-paths#dshHomePath`、`dsh-llm#BlockAssembler`/`createUserMessage`、`tool-excalidraw#SCENE_RELATIVE`/`sanitizeScene`、`dsh-fs#FsVersion`），并用 `--fix` 重整 `ui-polish`/`ui-ssh`/`ui-sidebar-documentpreview`/`workspace-files` 的依赖分区（peerDependencies 只留 cordis）；模块图文档与锁文件同步。全仓 67 包通过。
- **`verify-client-ui-i18n`**（2026-09-19 ui-polish 批清偿）：`CompactionRow` 的比例选项、Git 面板的状态字母与 diff 抽屉版本标记、LaTeX 面板的保存快捷键提示与 TeX 包显示名全部走 locale 字典。
- **wiki 自身撞上的文档门禁**（2026-09-19）：`verify-md-wrap`（硬换行段落改为一行一段）、`verify-repository-references`（`log.md` 里的裸 commit hash 改为文字描述）、`verify-concrete-terms`（JSDoc 里的“来源”用词改为具体表述）。

## 上游包被 fork 打补丁的地方（合并上游时需一并带过去）

- `packages/client/ui-sidebar-files`：`ctx.fs` 接缝的删除能力落到这棵树上后，该上游包多了每行删除控件 + 确认弹窗、`paths.ts`、以及 `workspaceFiles.delete` 的接线（见 [工作区文件删除](../entities/workspace-file-deletion.md)）。
- `packages/client/ui-sidebar-documentpreview`：office 文档预览与文本级编辑（见 [文档面板的编辑与保存](../entities/document-panel-editing.md)）。

## 复发预防

- fork 改了上游扫描范围内的包（`packages/*/*`）后，本地一次跑齐：`pnpm run test:docs` → `pnpm run typecheck` → `pnpm run lint` → `pnpm run constraints` → `pnpm run verify-package-dependencies`；新增包另跑 `pnpm run doc-sync`（生成物门禁），接线清单见 [星域包新包接线](xingchen-review-fixes.md#新-fork-包的门禁接线清单)。
- 新增 fork 包时同步四件套：子系统页 + `LINK_MAP` 类型分类、组 README（链子系统页）、`TOOL_PACKAGES`（若是工具包）、按 `node bin/normalize-crlf.mjs` 之外的生成器重跑（catalog 类）。
- fork 的 CI 不跑这些门禁，别把「CI 绿了」当成门禁通过。
