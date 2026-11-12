---
title: 合并上游 upstream/master（2026-11-12，0.2.2-rc.2）
type: query
tags: [upstream-sync, merge, 冲突取舍, office-kit, session-reminder, snapshot-refresh, 环境]
created: 2026-11-12
updated: 2026-11-12
sources: []
status: active
---

# 合并上游 upstream/master（2026-11-12，0.2.2-rc.2）

## 问题

把上游 `upstream/master` 自上一轮合并基点 上一轮合并基点（0.2.2-rc.1 头提交）起的 923 个提交并入 fork 的 `develop`（fork 侧同期 383 个提交），冲突 85 个文件，合并结果 3764 个文件（+139772 / −34978），验证后合回 `master` 并推送到 `me`（ReachForStar/dsh-studio）。fork 自研功能一项不删。

## 冲突取舍（沿用按来源逐文件策略）

| 类别 | 文件 | 取舍 |
| --- | --- | --- |
| fork 已删除、上游修改 | `apps/desktop-host/src/office-engine.ts`、10 个 `snapshots/session/*/system-prompt.expected.md` | 维持删除：Office 引擎解析改由 `packages/document/office-kit` 自己完成，Desktop Host 不再有引擎钩子；重复的快照 sidecar 被上游去重 |
| 版本与 fork 元数据 | `packages/bundle/web-app`、`packages/api/workspace-files`、`packages/a2a/a2a-status`、`packages/host/ssh-remotes` 的 `package.json` | `version` 取上游 0.2.2-rc.2；fork 的 `@reachforstar/*` 依赖与预设保留；上游新依赖（`dsh-util-ripgrep`、`dsh-terminal-panel`、`dsh-office-kit`、`dsh-tool-office`）并入 |
| 上游已删除 | `packages/api/account-controller`、`packages/credentials/deepseek-account-platform` 的引用 | fork 侧依赖与其 tsconfig 引用一并移除（账号改由 `dsh-deepseek-account` 与 `client-ui-account-notifications` 承担） |
| 双方都改 | `packages/client/ui-sidebar-files/*`、`packages/api/workspace-files/src/index.ts`、`filesFace` 调用点 | 逐块合并：fork 的搜索之外的**删除能力**与上游的**工作区搜索**并存 |
| 生成物 | lockfile、`docs/*.catalog.*`、`docs/capability-seams.*`、`.i18n.yaml`、`packages/preset/.../references/packages.md`、两个 `*-catalog.ts` | 先取上游，再用 `gen-*` 与 `verify-translation-pairing --write` 重生成 |

逐块合并里影响最大的四处：

- **`filesFace` 签名扩到 7 个参数**：上游加 `search` 与 `preferences`，fork 加 `removeEntry`。合并后的顺序是 `(list, removeEntry, watch, canOpen, navigationOf, search, preferences)`，`index.ts`、三个测试夹具与 `search-face.client.spec.ts` 同步。
- **同一个函数里 `pending` 撞名**：上游用 `pending` 表示搜索进行中，fork 的删除确认弹窗用同名 state。fork 侧改名为 `removal`/`setRemoval`，两套语义并存。
- **`workspaceFiles` 服务**：文档注释改成「搜索 + 删除 + 观测都在工作区内」，`Config` 新增 `search` 子配置，fork 的 `delete` 测试补该字段。
- **`capability-seams.zh.md`**：英文侧由 `gen-doc-graphs` 重生成（新增 `ctx.arena`），中文侧手工补齐 5 行（`ctx.arena`、`ctx.a2a`、`ctx.a2aHost`、`ctx.xingchen`、`ctx.sshSftp`）并同步 mermaid 块。

## 合并引入缺陷的修复

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| `officeToPdfRemote` 找不到 | 上游把 office 远端改名为 `officeKitRemote` | remotes 客户端贡献表取上游名，fork 的 `sshRemote`/`a2aStatusRemote` 保留 |
| client bundle 报 `dynamic chunk "./client.pica.js" has no generated import expression` | 新 rolldown 的 ESM 互操作助手由 `__toESM` 改名为 `require_rolldown_runtime.a` | `asyncChunkRequirePlugin` 的正则只认它包住的 `require(...)`，不再认死助手名 |
| `verify-translation-pairing` 报 `capability-seams` 三处不等 | 英文侧重生成后行数与 mermaid 节点增加 | 中文侧补齐行与 mermaid 块后 `--write` 重记 |
| `doc-typecheck` 报 `@reachforstar/dsh-a2a-status` 缺 `lib/typert.remote-client.d.ts.map` | 上游要求包把 typert 的 `.d.ts.map` 与 `src` 纳入 `files` | `a2a-status`、`host-ssh-remotes` 按上游同类包的 `files` 补齐 |
| `transform-corpus` 基线失败 | 被删包在本机留下的 `lib/` 构建残留（`api/account-controller`、`credentials/deepseek-account-platform`） | `pnpm run clean`（仓库自带脚本，清理已删包的残留产物） |
| `gen-client-catalog` 报 slot 报告超预算 | 上游把上限从 127 计起，fork 的 Excalidraw 注册再抬 4 行 | 上限改为实测值 131 并在注释写明来源 |
| `families.spec.ts`、`gen-tool-catalog.spec.ts` 数量不符 | 上游清单不含 fork 的 6 个 experimental 包与 `tool_search` 工具 | 按真实发布序列与工具集合补行 |
| ui-theme 两个新门禁报 fork 样式表 | 上游新增「特性样式表只用别名 token」「滚动容器在 elevated 表面上必须重绑滚动条」两条门禁 | `ui-a2a-status`、`ui-paper-reader`、`ui-polish`、`ui-ssh`、`ui-sidebar-documentpreview` 的裸色改别名 token，layer-2/3 表面改回非 elevated 表面 |

## 会话快照（test:snapshot）的收敛过程

刷新前 236 项红。根因是上游在本轮给运行期提醒加了 `<system-reminder>` 框架，并把 subagent 身份并入提醒正文；fork 的 v5 夹具是旧文本。

**关键坑：直接跑 `DSH_SNAPSHOT=refresh` 会把旧内容写成新夹具。** 夹具回放以**最高代际**的 `session.vN.jsonl` 作为脚本来源，而合并只更新了上游的 v4 文件。因此对「上游已重录、fork 还留着旧 v5」的场景，refresh 只是把旧脚本再写一遍 v5（例：`office-progressive-native` 里仍请求已删除的 `office-export-pdf` skill）。做法是先删掉这些场景的 `session.v5.jsonl`，让回放从上游的新 v4 取脚本，再 refresh 生成 v5。

处置后：236 红 → **6 红**（259 绿）。同一手法后来又修掉一个场景：`team-direct-inbox` 的旧 v5 仍在调用已改名的 `spawn_teammate` 工具、并给 `send_message` 传已移除的 `agent` 字段，父会话因此等子代理创建 `team-ready` 等满 60 秒；删掉旧 v5 从上游 v4 重放后一次通过。这是「最高代际即脚本来源」这条规则的第二个实例。

剩余 6 项：

- `session-snapshot-corpus` 的「V3 输入 + 保留代声明」：11 个只有 v4 的场景缺当代夹具——8 个 `snapshots/web/*`（`standard-dsh-doc`、`creator-persona`、`autolink-cjk-punctuation`、`present-after-closing-reply`、`creation-recommendations`、`question-composer-recommended`、`plugin-recommendations`、`steering` 一类）与 3 个 compaction 场景。这 8 个 web 夹具无法机械迁移：它们是给回放用的 authoring 输入，物理行不带 `seq`（由 web 脚手架在 `seedSession` 时补齐），严格校验的 v4→v5 迁移直接拒绝。要产出当代夹具只能走 `DSH_SNAPSHOT=record`（需要 `DEEPSEEK_API_KEY` 与真实模型）。
- `image-compaction`、`compaction-output-reserve`、`compaction-summary-headroom`、`model-switch-compaction`：脚本轮次少一次模型调用（`llm-replay: script exhausted — session requested model call #4 but its script has only 3`），需在有 key 的环境 `test:snapshot:record`。
- `persistent-pwsh-padded-completion`：需要 pwsh。

## 环境类失败（非仓库问题）

| 现象 | 根因 | 判定 |
| --- | --- | --- |
| `worktree`、`client-ui-forge` 等 4 个文件并发红 | 断言 git 英文报错前缀 | 加 `LC_ALL=C` 后 50 文件 1152 用例全绿 |
| `apps/desktop/tests/macos-notarization-proxy.spec.ts` 15 项 | 本机 pnpm 是独立可执行文件（`@pnpm/exe` 的 ELF），而 `flock-entry.ts` 用 `node <npm_execpath>` 拉起构建；另外 native 预构建清单要求 musl 与 landlock 产物 | 与合并无关：该文件与 `flock-entry.ts` 相对合并前零差异 |
| `a2a-host/tests/kafka-detect.spec.ts` | 用例用 `new URL(...).pathname` 拼路径，仓库路径含中文「项目」时是百分号编码 | 与合并无关，属用例写法 |
| 全量 `test` 中零散的 5 秒超时 | 并发下的预算 | 单独复跑通过 |

## 验证

- `pnpm run typecheck`：5 门全过。
- `pnpm run build`：10 门全过（artifacts + check + Web），701 个客户端产物。
- `pnpm run doc-sync`：43 门全过（含 `doc-typecheck`、双语配对 1327 对、文档构建）。
- `pnpm run test`（`LC_ALL=C`）：2813 文件通过 / 17 文件失败，逐文件复跑后只剩上表的环境项。
- `pnpm run test:snapshot`：259 通过 / 6 失败（见上节）。
- `pnpm run lint`、`pnpm run duplication`：仍红，且红项全在相对合并前未变的 fork 文件里，属 [fork 自研包的门禁红项清单](fork-gate-debt.md) 记录的存量。

## 复发预防

- 合并后先跑 `pnpm run clean` 再跑测试：被删包的 `lib/` 残留会让 corpus 类门禁把旧构建产物当基线。
- 快照夹具回放以最高代际文件为脚本来源，所以「先删旧 v5、再从上游 v4 回放」是唯一能换掉脚本内容的手法；直接 refresh 会把旧内容固化成新夹具。
- 上游把生成物布局或上限（`MAX_ENTRY_LINES`、`files` 清单、配对记录）改掉时，一律重生成并对齐实测值，不手改生成物。

## 涉及模块

- 合并范围：全仓 3764 个文件。
- 重点取舍：`packages/client/ui-sidebar-files`、`packages/api/workspace-files`、`packages/client/tsdown.client.ts`、`snapshots/**`。
- fork 适配：`packages/api/remotes`、`packages/fs/*`、`packages/llm/llm-pi-ai`、`packages/a2a/*`、`packages/host/ssh-remotes`、`packages/client/ui-polish`。

## 合并后 fork 入口消失的复盘（2026-11-12 晚）

用户报告 A2A / SSH / 星域 / ui-polish / Excalidraw / pi 后端入口消失、Token 用量与之前不同，并给出预设诊断行 `tool-subagent-list-agents (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started`。两处独立原因：

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 统计浮层与 Git/画布/LaTeX/SSH 标签页消失、Token 用量只剩核心胶囊 | ui-polish 客户端包在压缩单行产物下算不出同步 chunk 闭包，`import failed` 使整包不激活（见 [CJS 共享 runtime chunk](cjs-client-shared-runtime-chunk.md) 新增小节） | `syncChunkClosure` 按整份产物扫描包内 chunk require |
| 星域预设报 `never started` | 预设仍挂上游已删除的 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 子入口（`ERR_PACKAGE_PATH_NOT_EXPORTED`），并残留已改名的 `modelSelectionSettings` 与已删除的 `backgroundMode` | `presets/xingchen-qiming.patch.yml` 删该行、改 `modelSelection`、删 `backgroundMode` |

结论：合并保留 fork 文件并不等于 fork 文件仍然有效——上游改的是**被 fork 文件引用的接口**（子入口、配置键、构建产物形态）。合并收尾应额外做两项检查：预设/配置里每个插件名能 `require.resolve`，以及 `pnpm dsh web` 的控制台没有 `entry did not activate`。
