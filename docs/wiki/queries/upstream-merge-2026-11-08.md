---
title: 合并上游 upstream/master（2026-11-08）
type: query
tags: [upstream-sync, merge, 冲突取舍, 修复归属, 插件化, 会话格式, 桌面]
created: 2026-11-08
updated: 2026-11-08
sources: []
status: active
---

# 合并上游 upstream/master（2026-11-08）

## 问题

把上游 `upstream/master` 自上一轮同步基点起的 926 个提交并入 fork 的 `develop`（fork 侧同期 300 个非合并提交），并按三项要求收尾：

1. 同步上游、合回本地并推送。
2. 逐条核对 fork 既有 bug 修复是否已被上游修复：已修则采用上游实现，未修则保留 fork 修复。
3. 判断这些改动能否以插件形式提供，能改造的改造后提交到 `ReachForStar/dsh-client-ui-polish`。

上游本轮新增标签 `dsh-v0.2.2-alpha.3`、`dsh-v0.2.2-rc.1`，主要改动面：

- `ctx.fs` 接缝新增 `patchText`、`deleteFile`、`moveFile` 与 `FS_PATCH_MISMATCH`、`FS_SAME_TARGET` 错误码。
- `ui-sidebar-files` 重写为按分栏一棵树，目录树抽成受控工厂。
- `conversation.content` 工厂新增 `conversation.hero.frame` 渲染槽与 `widthControls` 本地槽。
- 会话格式仍为 v4；上游没有 v5、没有 `SessionHeader.backend`、没有 `assistant/peer-message`。
- `ToolRuntimeScheduler` 接缝被删除，工具调度改走别的路径。
- 桌面发布链路改为 `stable` 通道 + `publishChannel`。

## 解法

### 合并与冲突取舍

`git merge --no-commit --no-ff upstream/master` 产生 **148 个冲突文件**，按 [按来源取舍策略](../decisions/2026-09-upstream-sync.md) 逐个处理：

| 类别 | 处理 |
| --- | --- |
| fork 已删除的上游文件 | 维持删除，`git rm` 出索引 |
| 上游单方改动 | 取上游版本 |
| 双方都改 | 逐块合并，保留 fork 自研语义 |
| 生成物（lockfile、catalog、快照、双语配对） | 先取上游版本，再用生成脚本重做 |

逐块合并里影响最大的四处：

- **宽度控制**：保留 fork 的滑块实现（`ConversationWidthControls` + `widthSlider`），同时吸收上游新增的 `conversation.hero.frame` 槽与 `widthControls` 工厂本地槽契约；`ConversationContent` 用 `useFactorySlot('widthControls', …)` 取控件。
- **桌面更新通道**：保留 fork 的 `latest`/`linux-x64` 扩展，采纳上游的 `stable` 通道与 `publishChannel`；`unsigned` 构建一律不带强制更新策略，本地 unsigned（Windows 需 `DSH_DESKTOP_UNSIGNED=1`）跳过策略校验。
- **`startActivation` 参数扁平化**：上游把 `{ provider, request: {...} }` 改成 `{ provider, prompt, parent, agentOptions }`，星域调用点与测试按新签名对齐。
- **locale 字典**：所有 client 包统一注册 `{ zh, en, ja, es, fr, de, ru, pt }` 八个语种，缺失语种补译，不缩小注册集。

`linux-x64` 从 `apps/desktop/scripts/desktop-publish-targets.ts` 的 `targetSchema` 移除（上游测试要求未列出的 target 被拒绝），Linux 安装包只经 `release-desktop.yml` 产出；`retain-desktop-ci.ts` 的路由表判定改为字符串集合比较，因为该表只覆盖 mac 与 Windows 的单平台打包工作流。

### 合并引入缺陷的修复

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| fork-delivery 8 项失败 | v5 关系校验把继承前缀里的 delivery 归属也当成当前 Session 的 | `assertReleasedV5Relationships` 只在 `event.seq >= artifact.inheritedEventCount` 时校验 |
| webworker-packer 前驱版本取错 | 按 catalog 版本号选前驱，v5 下取不到 | 按 `parseSessionFormatLogFilename` 取同目录最高版本 |
| `vfs-example` 夹具代际不符 | `preview-turn-spacing` 仍写 v4 | 换为 `session.v5.jsonl` 并重生成投影缓存 |
| `transform-corpus` 基线失败 | 上游迁走 `packages/experimental/{agent-team,tool-agent-team}` 后留下旧 `lib/` | 删除残留目录 |
| 文档预览三包注册测试失败 | 字典注册扩到 8 语种，测试仍断言 `{ zh, en }` | 断言与导入同步扩到 8 语种 |
| 客户端 `:hover` 样式门禁失败 | 8 个 CSS Module 用裸 `:hover` | 包上 `@media (hover: hover)` |
| `subagent-pi` 8 项失败 | `SubagentRuntime.inject` 需要 `sessionProjections`，测试未装 | 补装 `SessionProjectionRegistry` |
| 双语配对与 catalog 漂移 | 上游改了文档结构与工具表 | `verify-translation-pairing --write` 重录 11 对，`gen-tool-catalog` 重生成 |

### 第 2 项：fork 既有修复的归属

判定方法：对每个 fork 修复提交取 `--unified=0` 的改动行，到上游 `upstream/master` 同路径文件里核对；文件不存在表示该包为 fork 独有；行为层面的结论另外读上游源码确认。

| 修复内容 | 上游状态 | 采用 |
| --- | --- | --- |
| `gen-cordis-catalog` 重复 `ToolCallId` 映射 | 上游已删除该行（`ToolCallId: 'core.md'` 不存在） | 上游 |
| `compile-referenced-projects` 堆内存 4096 → 8192 | 上游已是 8192 | 上游 |
| 工具调度符号丢失（改 `Symbol.for`）+ 拆除会话流视图 | 上游删除 `ToolRuntimeScheduler` 接缝，修复对象已不存在 | 上游（自然消失） |
| 持久化历史分叉 + `assistant/peer-message` 来源种类 | 上游 `SESSION_FORMAT_VERSION = 4`，无 v5 与 peer-message | fork |
| 任务列表跨轮次被清空（`stateVersion` 2→3） | 上游仍为 `stateVersion: 2` | fork |
| 桌面 A2A 状态页 Kafka 不可用（compose 经 stdin） | 桌面为 fork 包 | fork |
| 桌面客户端文件缺失 + Linux 图标 | 桌面为 fork 包 | fork |
| 画布导出与工具卡标签页切换 | `ToolCallCommonProps.openView` 为 fork 独有 | fork |
| HTTP 桥接背压监听器泄漏 | 上游同文件无该改动 | fork |
| 星域预设被入站 A2A 状态隐藏 | xingchen 为 fork 独有包 | fork |
| SSH 面板表格容器样式 | fork 包 | fork |
| SFTP 下载 400（路由缺 `requestBody`） | fork 包 | fork |
| remote 模块解析失败与 zod 依赖缺失 | 上游同位置已有部分改动 | fork 增量保留 |
| 桌面启动继承 `ELECTRON_RUN_AS_NODE` | 桌面为 fork 包 | fork |
| `api-remotes` 客户端 bundle 解析 a2a-status | fork 包 | fork |
| kafka-detect 模块加载崩溃 | fork 包 | fork |
| 插件 config undefined 报错 | 上游同文件无该改动 | fork |
| 会话重载允许 assistant 空 model 来源 | `pi-agent-loop` 为 fork 包 | fork |
| CJS 客户端包共享 runtime chunk 导致 web boot 失败 | fork 构建产物问题 | fork |
| 文档预览插件加载失败 + 构建期 builtin 守卫 | fork 包 | fork |
| 无内置目录网关的运行期模型解析 | 上游同文件无该改动 | fork |
| pi 会话 resume 丢历史与错用 dsh 后端 | `pi-agent-loop` 为 fork 包 | fork |
| 自动压缩在轮次中途调用空闲专用接口 | 上游同文件无该改动 | fork |
| AMAX 网关拒绝 developer role | `llm-pi-ai` 为 fork 包 | fork |
| AMAX 取模型名称回退为 id | fork 包 | fork |
| Web SSH 设置与文档门禁 | fork 包 | fork |
| Web 设置页 e2e 快照与状态测试 | fork 包 | fork |

结论：27 项里只有 3 项由上游解决，其余 24 项保留 fork 实现。

### 第 3 项：插件化分类

插件化的硬条件：只依赖已发布的公开接缝，不需要改 harness 源码。按这个条件分三类。

**A. 已经是插件，且已在插件仓库**

| 包 | 形态 |
| --- | --- |
| `@reachforstar/dsh-client-ui-polish` | 双面 Web 插件（client bundle + host 路由/设置） |
| `@reachforstar/dsh-tool-excalidraw` | host 工具插件（四个白板工具） |
| `@reachforstar/dsh-subagent-pi` | host 子智能体提供方 |
| `@reachforstar/dsh-llm-amax` | host 模型提供方（fork 已并入 `llm-pi-ai`，只在插件仓库独立存在） |

**B. 已是独立 Cordis 插件，本次已同步进插件仓库**

16 个 `@reachforstar/*` 包都是非 private 的独立包，通过 preset patch 组合，不依赖 fork 对 harness 的补丁：

- A2A：`dsh-a2a`、`dsh-a2a-host`、`dsh-a2a-status`、`dsh-tool-a2a`、`dsh-client-ui-a2a-status`
- SSH/SFTP：`dsh-ssh`、`dsh-ssh-local`、`dsh-host-ssh-remotes`、`dsh-fs-sftp`、`dsh-subprocess-sftp`、`dsh-tool-ssh`、`dsh-client-ui-ssh`
- 星域：`dsh-xingchen`
- 另外三个已在 A 类

本次同步了 9 个包到 `ReachForStar/dsh-client-ui-polish`（提交 `b8ac7bb`）：`ui-polish`、`tool-excalidraw`、`subagent-pi`、`ssh`、`ssh-local`、`host-ssh-remotes`、`subprocess-sftp`、`tool-ssh`、`client-ui-ssh`。`llm-amax` 沿用插件仓库既有副本。

同步代价与两条硬约束：

- 依赖改写为已发布版本：`@deepseek-ai/cordis` → `~4.1.0`、`@deepseek-ai/schemastery` → `~3.19.0`、`cordis-plugin-*` → `^1.1.0`、其余 `@deepseek-ai/*` → `0.2.2-rc.1`、`@reachforstar/*` → `workspace:^`。客户端跟随官方 0.2.2 的拆分，改用 `dsh-client-store`、`dsh-client-connection`、`dsh-client-ui-slots`。
- `fs-sftp` 无法同步：它依赖 fork 给 `ctx.fs` 新增的 `remove`/`writeBytes` 与 `@deepseek-ai/dsh-fs` 拆出的 text 工具函数，`0.2.2-rc.1` 没有这些导出。A2A 与星域包未纳入本次范围。

移植时另有三处必须绕开已发布接口的缺口：

- 发布版 `dsh-api-remotes` 的转发 allowlist 不含任何 `ssh/*` 条目，`ui-polish` 的 SSH PTY 订阅改为 host 侧自建 SSE 路由 `/ssh-events`，客户端用 `EventSource` 消费。
- 发布版 `ToolCallCommonProps` 没有 `openView`，`ExcalidrawToolView` 只渲染标题、参数摘要与 SVG 缩略图。
- 发布版 `compactIfNeeded` 没有第 4 个参数，插件版 `ui-polish` 不含「自动压缩阈值」功能。

**C. 必须留在 fork 补丁，不能插件化**

| 改动 | 原因 |
| --- | --- |
| 会话格式 v4 → v5、`SessionHeader.backend`、`assistant/peer-message` | 改的是持久化格式与迁移包，属于 harness 核心 |
| `ctx.fs` 新增 `remove`、`writeBytes`、`patchText`、`deleteFile`、`moveFile` | 能力接缝的 Service Definition 在核心包内 |
| `ToolCallCommonProps.openView` | 工具卡契约由 `ui-tool` 拥有，插件只能消费 |
| 宽度滑块 | 依赖 `conversation.content` 工厂的 `widthControls` 本地槽，本地槽由调用方（`ConversationMainPanel`）选择，插件无法替换；上游同位置是自己的拖拽手柄 |
| 桌面外壳、打包、更新源 | Electron 主进程与构建产物，不在插件加载面内 |
| 构建/发布脚本与 workflow | 仓库级工具链 |

因此第 3 项的答案是：**部分可以**。界面增强、工具、子智能体、模型提供方与 A2A/SSH 这些整包能力可以插件化；持久化格式、能力接缝、工具卡契约、宽度滑块与桌面外壳必须留在 fork。

### 插件仓库 CI 的六处修复

插件仓库在干净 runner 上暴露了本地装不出来的六处缺口，逐个修掉后 `ci` 全绿（`42455059834`）：

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| `ui-polish` prepare 报 TS7016：`js-yaml` 无声明文件 | 包内 `git-service.ts` 引入 `js-yaml`，但只声明了运行时依赖 | 补 `@types/js-yaml` 到 devDependencies |
| `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS` | pnpm 11 默认不跑依赖的构建脚本，`ssh2`/`cpu-features` 需原生绑定 | `allowBuilds` 放行 `ssh2`、`cpu-features` |
| 根 `tsdown.client.ts` 找不到 `lightningcss`、`tsdown` | 脚本直接 import 两个包，根 manifest 未声明；本地靠父目录或 `.pnpm/node_modules` 命中 | 根 devDependencies 显式声明 |
| `ui-polish` 声明生成报 TS2883，`Config` 引用越界 | 同一 workspace 里 `schemastery` 同时存在 3.18.1 与 3.19.0 | overrides 固定 `@deepseek-ai/schemastery: 3.19.0` |
| `subagent-pi` 测试报 `Cannot find package 'tsx'` | 测试用 `import.meta.resolve('tsx')` 取 loader，包内未声明 | 包 devDependencies 补 `tsx` |
| `ui-polish` 字体列表在 CI 返回 500 | `/latex/fonts` 的 `list` 分支先 `await xelatex()`，无 TeX 的 runner 直接抛错 | 字体列表改用可缺省的引擎解析，编译类路径保持 fail-loud（fork 已同步同一修复） |

前五处是「本地能过、干净环境不过」的依赖声明缺口，共同前提是克隆目录在 fork 仓库内时，Node 会向上命中 fork 的 `node_modules`。验收必须在 fork 之外克隆（本次用 `/data/d/dsh-plugin-ci-check`）再 `pnpm install --frozen-lockfile`。

第六处是真实产品缺陷：面板在没装 TeX 的机器上连项目字体都列不出来。复现方式是把 `PATH` 指向空目录再跑 `tests/latex-service.host.spec.ts`：修复前 `installs and lists project fonts` 失败，修复后 28 项全过。

## 涉及模块

- 合并范围：全仓 3271 个文件。
- 重点取舍：`packages/client/ui-conversation`、`apps/desktop/scripts`、`packages/session/session-format-v4-to-v5`、`packages/experimental/webworker-*`。
- 归属核对：`packages/core/pi-agent-loop`、`packages/todo/tool-todo`、`packages/fs/*`、`packages/client/ui-tool`。
- 插件化：`packages/{a2a,remote,host,client,subagent,fs,xingchen}` 下的 16 个 `@reachforstar/*` 包。

## 验证

- `pnpm run typecheck`：5 门全过。
- `pnpm run build`：通过（`build:artifacts` + `build:check`）。
- `pnpm run doc-sync`：通过；17 个生成脚本全部重生成成功。
- 全量 `pnpm run test`：55118 项通过，20 项失败分布在 5 个文件，全部是 5 秒超时。
- 把这 5 个文件单独复跑：217/218 通过；唯一失败是 `controller.host.spec.ts` 断言 git 报错前缀 `fatal: `，未设 `LC_ALL=C` 时 git 输出中文「致命错误」，加上 `LC_ALL=C` 后该用例通过。超时与语言环境都属本机条件，无合并引入的失败。
- `verify-package-readme-model-experience`、`verify-persistence-changes`、`verify-persistence-formats --write`、`verify-translation-pairing`（1259 对）、`verify-md-links`（2575 文件）通过。
- 推送 `develop` 与 `master` 前的 `typecheck` 钩子均通过。

全量测试剩余的 20 项失败：

- `packages/experimental/{worktree,client-ui-forge}`：本机默认 `git 2.34.1` 不支持 `worktree ... -z`；改用 `/home/asus/envs/git-new/bin/git`（2.56.0）后全部通过，属环境限制。
- `scripts/compile-referenced-projects.spec.ts` 与个别 host spec 的 5 秒超时：并发下的预算问题，单独复跑通过。

## 复发预防

- 合并前先确认 `git --version`：`worktree`/`client-ui-forge` 需要 `-z` 支持（≥ 2.36）。本机默认 git 2.34.1，测试前把 `/home/asus/envs/git-new/bin` 放进 `PATH`。
- 上游迁走包目录后要删除残留的 `lib/`、`node_modules/`，否则 `transform-corpus` 会把旧构建产物当成基线失败。
- 双语配对记录只能用 `verify-translation-pairing --write <pair>` 重录，不要手改 `.i18n.yaml`。
- 判断「上游是否已修」不能只看提交标题：工具调度符号丢失那项的修复对象被上游删除，属于自然消失，不是等价修复。
- 插件化评估先看接缝归属：Service Definition 在核心包内的改动一律不能插件化，只有纯消费公开槽与服务的能力可以。
- 插件仓库验收要在 fork 之外克隆后跑 `pnpm install --frozen-lockfile`；在 fork 目录内安装会命中 fork 的 `node_modules`，掩盖缺失的依赖声明。
- 依赖缺失类问题按「包内是否声明」排查，不要靠提升目录里的偶然存在蒙混；声明式依赖是干净 runner 上唯一可靠来源。
