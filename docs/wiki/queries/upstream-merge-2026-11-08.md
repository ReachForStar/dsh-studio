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

把上游 `upstream/master` 自上一轮基点 `ce7073d5125` 起的 926 个提交并入 fork 的 `develop`（fork 侧同期 300 个非合并提交），并按三项要求收尾：

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

判定方法：对每个 fork 修复提交取 `--unified=0` 的改动行，到 `upstream/master`（`fcc0ad4621`）同路径文件里核对；文件不存在表示该包为 fork 独有；行为层面的结论另外读上游源码确认。

| fork 提交 | 修复内容 | 上游状态 | 采用 |
| --- | --- | --- | --- |
| `6242e5febb` | `gen-cordis-catalog` 重复 `ToolCallId` 映射 | 上游已删除该行（`ToolCallId: 'core.md'` 不存在） | 上游 |
| `8fcad26785` | `compile-referenced-projects` 堆内存 4096 → 8192 | 上游已是 8192 | 上游 |
| `d2e58b6e7e` | 工具调度符号丢失（改 `Symbol.for`）+ 拆除会话流视图 | 上游删除 `ToolRuntimeScheduler` 接缝，修复对象已不存在 | 上游（自然消失） |
| `81f077824d` | 持久化历史分叉 + `assistant/peer-message` 来源种类 | 上游 `SESSION_FORMAT_VERSION = 4`，无 v5 与 peer-message | fork |
| `20091ba685` | 任务列表跨轮次被清空（`stateVersion` 2→3） | 上游仍为 `stateVersion: 2` | fork |
| `c06113a1ab` | 桌面 A2A 状态页 Kafka 不可用（compose 经 stdin） | 桌面为 fork 包 | fork |
| `c5491e0abe` | 桌面客户端文件缺失 + Linux 图标 | 桌面为 fork 包 | fork |
| `6ebe393597` | 画布导出与工具卡标签页切换 | `ToolCallCommonProps.openView` 为 fork 独有 | fork |
| `654c1b10a9` | HTTP 桥接背压监听器泄漏 | 上游同文件无该改动 | fork |
| `62a7c9fefb` | 星域预设被入站 A2A 状态隐藏 | xingchen 为 fork 独有包 | fork |
| `dc0c30b483` | SSH 面板表格容器样式 | fork 包 | fork |
| `c427446b26` | SFTP 下载 400（路由缺 `requestBody`） | fork 包 | fork |
| `e694ded953` | remote 模块解析失败与 zod 依赖缺失 | 上游同位置已有部分改动 | fork 增量保留 |
| `445b8858af` | 桌面启动继承 `ELECTRON_RUN_AS_NODE` | 桌面为 fork 包 | fork |
| `de642c3cc5` | `api-remotes` 客户端 bundle 解析 a2a-status | fork 包 | fork |
| `adfcc6974d` | kafka-detect 模块加载崩溃 | fork 包 | fork |
| `c80a6a9c72` | 插件 config undefined 报错 | 上游同文件无该改动 | fork |
| `adb9f4af5b` | 会话重载允许 assistant 空 model 来源 | `pi-agent-loop` 为 fork 包 | fork |
| `f9f1b21a95` | CJS 客户端包共享 runtime chunk 导致 web boot 失败 | fork 构建产物问题 | fork |
| `f38b722cfa` | 文档预览插件加载失败 + 构建期 builtin 守卫 | fork 包 | fork |
| `6f5761f42a` | 无内置目录网关的运行期模型解析 | 上游同文件无该改动 | fork |
| `c5a1104d0f` | pi 会话 resume 丢历史与错用 dsh 后端 | `pi-agent-loop` 为 fork 包 | fork |
| `344a6cc65d` | 自动压缩在轮次中途调用空闲专用接口 | 上游同文件无该改动 | fork |
| `f67fd026ad` | AMAX 网关拒绝 developer role | `llm-pi-ai` 为 fork 包 | fork |
| `4e9734e0d1` | AMAX 取模型名称回退为 id | fork 包 | fork |
| `4a8dcefcdd` | Web SSH 设置与文档门禁 | fork 包 | fork |
| `6b40d38160` | Web 设置页 e2e 快照与状态测试 | fork 包 | fork |

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

**B. 已是独立 Cordis 插件，但只在 fork 内组合**

16 个 `@reachforstar/*` 包都是非 private 的独立包，通过 preset patch 组合，不依赖 fork 对 harness 的补丁：

- A2A：`dsh-a2a`、`dsh-a2a-host`、`dsh-a2a-status`、`dsh-tool-a2a`、`dsh-client-ui-a2a-status`
- SSH/SFTP：`dsh-ssh`、`dsh-ssh-local`、`dsh-host-ssh-remotes`、`dsh-fs-sftp`、`dsh-subprocess-sftp`、`dsh-tool-ssh`、`dsh-client-ui-ssh`
- 星域：`dsh-xingchen`
- 另外三个已在 A 类

这些包可以按同样方式抽到插件仓库，代价是把 `workspace:*` 改成已发布版本、并跟随官方 0.2.2 的客户端 API 迁移（`dsh-client-runtime` 已拆分）。

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

## 涉及模块

- 合并范围：全仓 3271 个文件。
- 重点取舍：`packages/client/ui-conversation`、`apps/desktop/scripts`、`packages/session/session-format-v4-to-v5`、`packages/experimental/webworker-*`。
- 归属核对：`packages/core/pi-agent-loop`、`packages/todo/tool-todo`、`packages/fs/*`、`packages/client/ui-tool`。
- 插件化：`packages/{a2a,remote,host,client,subagent,fs,xingchen}` 下的 16 个 `@reachforstar/*` 包。

## 验证

- `pnpm run typecheck`：5 门全过。
- `pnpm run build`：通过（`build:artifacts` + `build:check`）。
- `pnpm run doc-sync`：通过；17 个生成脚本全部重生成成功。
- 全量 `pnpm run test`：55118 项通过，20 项失败全部归因为环境与基线（见下），无合并引入者。
- `verify-package-readme-model-experience`、`verify-persistence-changes`、`verify-persistence-formats --write`、`verify-translation-pairing`（1259 对）、`verify-md-links`（2575 文件）通过。
- 推送 `develop` 与 `master` 前的 `typecheck` 钩子均通过。

全量测试剩余的 20 项失败：

- `packages/experimental/{worktree,client-ui-forge}`：本机默认 `git 2.34.1` 不支持 `worktree ... -z`；改用 `/home/asus/envs/git-new/bin/git`（2.56.0）后全部通过，属环境限制。
- `scripts/compile-referenced-projects.spec.ts` 与个别 host spec 的 5 秒超时：并发下的预算问题，单独复跑通过。

## 复发预防

- 合并前先确认 `git --version`：`worktree`/`client-ui-forge` 需要 `-z` 支持（≥ 2.36）。本机默认 git 2.34.1，测试前把 `/home/asus/envs/git-new/bin` 放进 `PATH`。
- 上游迁走包目录后要删除残留的 `lib/`、`node_modules/`，否则 `transform-corpus` 会把旧构建产物当成基线失败。
- 双语配对记录只能用 `verify-translation-pairing --write <pair>` 重录，不要手改 `.i18n.yaml`。
- 判断「上游是否已修」不能只看提交标题：`d2e58b6e7e` 的修复对象被上游删除，属于自然消失，不是等价修复。
- 插件化评估先看接缝归属：Service Definition 在核心包内的改动一律不能插件化，只有纯消费公开槽与服务的能力可以。
