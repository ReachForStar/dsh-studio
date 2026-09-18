---
title: fork 自研包的门禁红项清单
type: query
tags: [gates, doc-sync, lint, coverage, constraints, fork, 待办]
created: 2026-09-18
updated: 2026-09-18
sources: []
status: active
---

# fork 自研包的门禁红项清单

## 问题

fork 自研包（`packages/remote/*`、`packages/a2a/*`、`packages/core/pi-agent-loop`、`packages/fs/tool-excalidraw` 等）在上游门禁上留下成片红项。fork 自己的 `.github/workflows/` 只有 6 个非测试型工作流（build-preview-cloudflare / expected-filenames / issue-policy / landlock-run / node-addon-system / weighted-approval），**不跑** `doc-sync`、`lint`、`constraints`、`test:coverage`，所以这些红项只会在本地手动执行门禁时暴露。2026-09-18 执行 `pnpm run doc-sync`（31 通过 / 10 失败）、`pnpm run lint`（18 处）、`pnpm run constraints`、`pnpm run verify-package-dependencies` 后盘点如下（已随本批修掉的除外）。

## 红项与修复方向

| 门禁 | 报错 | 归属 | 修复方向 |
| --- | --- | --- | --- |
| `verify-doc-graphs`、`verify-cordis-catalog` | 服务签名引用未分类类型：`AgentCard`、`A2APeerRef`、`A2APeerConfig`、`A2APeerReply`、`A2ASendRequest`、`A2APeerInfo`（a2a）；`FsWriteBytesOutcome`（`ctx.fs.writeBytes`）；`WorkspaceFileWriteGuard`（`workspaceFiles.write`/`writeBytes`） | A2A 批 + office 批 | 前者需要 `docs/subsystems/a2a.md` 并在 `scripts/gen-cordis-catalog.ts` 的 `LINK_MAP` 登记；后两者归 `filesystem.md` / 相应 API 页 |
| `verify-subsystem-pages` | `packages/a2a/README.md: package group has no group README` | A2A 批 | 新建 `packages/a2a/README{,.zh}.md` + i18n（组 README 需链 `../../docs/subsystems/a2a.md`） |
| `verify-tool-catalog` | `tool-a2a` 未登记进 `TOOL_PACKAGES` | A2A 批 | 在 `scripts/gen-tool-catalog.ts` 补 `ToolPackage`（dir/pkg/source/requires/writes/mount） |
| `verify-client-catalog` | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 过期 | office 批 | `pnpm run gen-client-catalog` 后提交生成物 |
| `verify-persistence-catalog`、`verify-persistence-changes` | `docs/persistence-{catalog,schema}` 过期 | 会话 v3 `backend` 字段批 | `pnpm run gen-persistence-catalog` 后提交生成物（diff 可能覆盖多份双语文档） |
| `verify-config-source-ownership` | `packages/bundle/web-app/cordis.patch.yml:289` 内联 `apiKey: !!js process.env.DSH_A2A_API_KEY` | A2A 批 | 让 `dsh-a2a-host` 接受 `apiKeyEnv` 并经 `ctx.credentials`/环境快照解析，patch 只写变量名（与 `llm-*` 的 `apiKeyEnv` 同型） |
| `pnpm run lint` | `tool-excalidraw`：src 的 `no-base-to-string`/`no-unnecessary-type-assertion`，tests 的 `no-unsafe-*`（excalidraw 场景 API 是 `any`） | excalidraw 批 | 给场景元素补类型（或 `unknown` + 收窄），测试用类型化 fixture |
| `pnpm run lint` | `pi-agent-loop/src/agent.ts` 调已弃用的 `snapshotEvents`；`tests/translator.spec.ts` 多余类型断言 | pi 后端批 | 迁到同步读取的替代 API；删掉多余断言 |
| `pnpm run constraints` | `dsh-a2a{,-host}`、`dsh-tool-a2a` 的 `repository` 应为 `git+https://github.com/deepseek-ai/deepseek-harness.git` + 对应 `directory`；`dsh-pi-agent-loop` 版本须与根 `0.1.6-alpha.1` 一致 | A2A / pi 批 | 直接改 manifest |
| `verify-package-dependencies` | `workspace-files` 引 `FsVersion`、`ui-polish` 引 `tool-excalidraw#sanitizeScene`/`SCENE_RELATIVE`、`home-paths#dshHomePath` 未分类 | office / excalidraw 批 | 在 `scripts/package-dependency-policy.ts` 的分类表登记为 safe 或 peer-required |
| `verify-client-ui-i18n` | 8 处硬编码 UI 文案：`ui-polish` 的 `CompactionRow`（`80%（默认）`）、`GitPanel.statusLabel`（untracked/modified/added/deleted/renamed/changed）、`MutationDiffPanel.fileGlyph` 的 `'J'` 字形返回 | ui-polish 批 | 前两类走 locale 字典；字形函数返回单字符标记而非文案，需在该门禁里加一条有理由的例外（或改判定启发式） |
| `test:coverage` per-file 100% | 实测：`a2a/src/{index,client,server,task-store}.ts` 82–98%、`a2a-host/src/{index,executor}.ts` 82–96%、`tool-a2a/src/index.ts` 83%、`remote/fs-sftp/src/index.ts` 73.8% 语句 / 62.9% 分支、`remote/subprocess-sftp/src/index.ts` 80.8% / 65.4% | 各 fork 批 | 逐文件补分支与错误路径测试（远端 shell 探测失败、abort、符号链接、并发创建等） |

## 本批（2026-09-18 远端工作区）已修掉的红项

- `verify-export-jsdoc`：全仓库通过（补了 a2a、office、pi-agent-loop、fs `text.ts`、两个新 provider 的 JSDoc/@param/@returns）。
- `verify-doc-graphs` 的解析期两类报错：`A2AHostService.store` 缺显式类型、`TaskStore.list` 默认参数缺显式类型（typert 分析要求公开成员显式标注）。
- `pnpm run lint` 中本批新增的 `sonarjs(no-identical-functions)`：`remote/ssh/tests/stub-service.ts` 的两个会话 stub 抽出共享基类 `StubSession`。
- `test:docs`（doc-quick）20/20、`pnpm run typecheck` 全通过。
- **客户端 bundle 无 Node builtin 门禁**（已补）：动态 bundle 的 factory 序言里出现 Node builtin 时，构建与服务都通过，直到浏览器启动才变成「entry did not activate / import failed」。2026-09-18 在 `packages/client/tsdown.client.ts` 加 `dsh-client-prologue-builtins`（序言 require 到 Node builtin 即构建失败）；`fflate` 默认解析到 Node 版是首个实例。

## 复发预防

- fork 改了上游扫描范围内的包（`packages/*/*`）后，本地一次跑齐：`pnpm run test:docs` → `pnpm run typecheck` → `pnpm run lint` → `pnpm run constraints` → `pnpm run verify-package-dependencies`；新增包另跑 `pnpm run doc-sync`（生成物门禁）。
- 新增 fork 包时同步四件套：子系统页 + `LINK_MAP` 类型分类、组 README（链子系统页）、`TOOL_PACKAGES`（若是工具包）、按 `node bin/normalize-crlf.mjs` 之外的生成器重跑（catalog 类）。
- fork 的 CI 不跑这些门禁，别把「CI 绿了」当成门禁通过。
