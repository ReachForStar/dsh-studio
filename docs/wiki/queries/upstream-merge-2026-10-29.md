---
title: 合并上游 upstream/master（2026-10-29，0.2.2-alpha.2 同步）
type: query
tags: [upstream-sync, merge, 冲突取舍, 生成物, 快照, 持久化记录, 环境前置]
created: 2026-10-29
updated: 2026-10-29
sources: []
status: active
---

# 合并上游 upstream/master（2026-10-29，0.2.2-alpha.2 同步）

## 问题

把上游 `upstream/master` 自上一轮合并基点起的 637 个提交（459 个非合并提交，含 0.2.1-rc.4、0.2.2-alpha.1、0.2.2-alpha.2 三代版本同步，LiveShare、Forge 变更请求套件、模型目录徽标、Web 包体压缩）并入 fork 的 `develop`。fork 侧同期 301 个提交。规模：**413 个冲突文件、534 处冲突块**，其中 343 个是纯版本号的 `package.json` 冲突。

## 取舍（沿用按来源策略）

| 类别 | 处理 |
| --- | --- |
| 版本号 | 343 个 `package.json` 只在上游侧改版本，直接取上游 `0.2.2-alpha.2`；25 个两侧都改的按字段规则合并（默认取上游，再逐个键改回 fork 侧或删除） |
| fork 已删除的云端 CI 与发布工作流 | 上游本轮改动的 `ci.yml`、`e2e.yml`、`release.yml`、`release-publish.yml`、`build-exe-for-python-sdk.yml` 与 `scripts/ci-workflow.spec.ts`、`scripts/tests/ci-release-selfhosted.spec.ts` 维持删除 |
| 上游本轮删除的包 | 上游用模型目录徽标取代临时标记包 `ui-deepseek-model-label-1017` 并附升级指南，fork 侧对它只有版本号差异 → 随上游删除；`packages/bundle/web-app` 的依赖与 patch 同步去掉该包 |
| 生成物 | `docs/{capability-seams,event-producer-consumer,persistence-catalog,persistence-schema.json,config-catalog,module-graph,tool-catalog,subsystems/README}`、`slot-catalog.ts`、`api-catalog.ts`、`pnpm-lock.yaml` 取上游后重生成 |
| fork 与上游同时改的源码 | `apps/desktop/scripts/*`、`packages/client/ui-conversation/src/client/input/decorations.ts`、`packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx`、`packages/util/official-bundles/src/bundles.ts`、`vitest.config.ts`、`tsconfig.base.json`、`scripts/package-dependency-policy.ts` 逐块合并（详见下节） |
| 快照 | 冲突涉及的 4 份 Web 插件页 golden 用 `DSH_SNAPSHOT=refresh` 重录，不手工合并 |

逐块合并的要点：

- `decorations.ts`：上游把 `FOLDER_REF_RE` 换成 `PATH_TOKEN_RE` + `pathEnd()`（覆盖带引号路径、尾随标点、目录前缀不截断），fork 的 `#` 触发词保留，删掉 fork 侧被取代的 `FOLDER_REF_RE`。
- `PluginManagerPage.tsx`：上游把「不支持平台」提示加进 `PackageCard`，fork 的 `{footer}` 同位置并存；`props.setEnabled` 内联调用换成上游新抽的 `setBundleEnabled()`。
- `bundles.ts`：`OPTIONAL_BUNDLES` 尾部按 fork 的 browser-use、computer-use 之后追加 forge-bundle，顺序与 Web 插件页 golden 一致。
- `upload-target.ts` / `desktop-upload-plan.ts`：取上游的 `desktopTargetPlatform()` 与 `desktopLatestInstallerFilename()` 结构，把 fork 的 linux-x64 目标喂进这两个函数。
- `vitest.config.ts`：fork 的 `testResolveAlias`（excalidraw CSS + claude-code 测试替身）与上游新增的 liveshare 生成面替身合成一个别名集，三条道共用。

## 合并引入的真实缺陷（均已修复）

1. **LiveShare 的 Remote 端点完整性表缺 fork 端点**：上游 `packages/experimental/liveshare/src/endpoint-classification.ts` 用 `satisfies Record<RemoteEndpoint, ViewerEndpointClass>` 强制「每个端点都要有分类行」，fork 的 `a2a/status`、`workspaceFiles/delete|write|writeBytes` 四个端点没有行，client 编译直接失败（`TS1360` + `TS2344 UnclassifiedEndpoint 不是 never`）。按该表的分组补成 `owner-only`（既有的 `workspaceFiles/*` 与部署级诊断都是这一类）。
2. **上游新增的固定下载命名函数不认 linux**：`desktopLatestInstallerFilename()` 只判 mac/win，linux-x64 会被命名成 `dsh-latest-macos-x64.dmg`。补 `linux-x64 → dsh-latest-linux-x64.AppImage` 分支并同步 JSDoc 参数联合。
3. **LiveShare 装配页的 `/remote` 重写只认上游作用域**：`tests/viewer-page.client.ts` 用 `@deepseek-ai/` 前缀的正则改写 Remote 装配的导入，fork 的 `@reachforstar/dsh-host-ssh-remotes/remote`、`@reachforstar/dsh-a2a-status/remote` 落回裸导入，12 个 viewer 用例报解析失败。正则放宽到任意作用域（`@[^']+`），生成面由工作树发现器覆盖 fork 包。
4. **生成物中文侧落后**：`docs/capability-seams.zh.md` 缺 fork 的 a2a/ssh/xingchen/subagent-pi 结构块（英文侧由 `gen-doc-graphs` 从合并后的树重生成，中文侧不在拼接名单里），`docs/tool-catalog.zh.md` 缺 `todo_write` 新增的收尾一句。按英文侧结构块与行序补齐后重录配对，pairing 门禁 1183 对全绿。
5. **上游删包后的引用残留**：`docs/persistence-catalog.*`、`slot-catalog.ts` 等按上游取回后必须重生成，否则仍列 `ui-deepseek-model-label-1017`；`pnpm install` 负责把 fork 私有依赖重新解析进 lockfile。

## 补记持久化类型记录

合并后 `pnpm run verify-persistence-changes` 报 5 个根未确认：上游 `2026-10-25-skill-catalog-incomplete` 成为 `event:user/message`、`event:developer/message`、`event:agent/inbox/spliced`、`event:session/title-llm-request` 的新 tip，其快照按上游源码算出、不含 fork 的 `ui-polish`、`a2a-seat` 来源种类；`event:assistant/peer-message` 的 tip 是 fork 自己的 `2026-10-27-fork-peer-source-kind`，其 digest 落后于上游本轮改动的消息联合。

处理：用 `pnpm --silent run persistence-changes --record 2026-10-29-fork-message-source-kinds --prose <双语说明> --decision same-version` 生成后继记录，一次覆盖 5 个根（4 个 `attribution-kind-added` + 2 个 `union-variants-changed`）。兼容性口径：未挂载 fork 生产者的读者按「自己树中不生产的来源种类」既有行为处理这些取值；更早的记录不可能含这些取值，故旧记录解读不变；`kind` 仍能选出每个分支，不需要新判别属性。改完 `verify-persistence-changes` 为 67 根匹配 22 条记录。

这与 [持久化历史分叉与来源种类补记](persistence-history-fork-repair.md) 是同一类问题的两种形态：上一轮是 fork 记录与上游记录**分叉**（要改父记录），本轮是上游记录**排在 fork 记录之后**（要加后继记录）。判定都只看门禁给出的每根 tip。

## 顺手清偿的既有文档门禁

- `docs/wiki/log.md` 三处裸 commit hash、`docs/wiki/queries/release-dsh-0.2.1-rc.3.md` 与 log 里的 `prove`+`nance` 用词：改为描述性表述，门禁口径见 [本机合并与门禁踩坑](windows-merge-gates.md)。
- `.github/workflows/release-desktop.yml` 的签名步骤原先引用 GitHub 那个名字含被禁词的行动；改用同版本号的通用证明行动 `actions/attest@v4.2.2`（不传谓词时默认生成 SLSA 构建证明，输入项 `subject-checksums` 与作业权限 `id-token: write`、`attestations: write` 都不变）。**此改动未在本机实跑过发布工作流**，属待验证项。

## 环境前置（本机首次实测确认）

仓库要求 Node `>=24.9`，本机原先只有 nvm 的 v22.23.3，且缺 Node-API 头文件与较新的 git。本轮安装三样东西后门禁才可信：

- `nvm install 24` → v24.22.2。`ptc-runtime-node` 的 `vm-script.spec.ts` 有一条断言 `using` 声明的用例，V8 在 Node 22 不解析 `using`，只有 Node 24 过。
- `native/system/scripts/build.ts` 从 `process.execPath` 的相对位置找 `include/node`，nvm 装的 Node 带该目录，而 `/opt/DeepSeek Harness/.../primary-runtime` 里那个不带；用带不到头文件的 Node 会让 `build:artifacts` 的 native 门失败并级联跳过 7 门。
- conda 环境装 git 2.56（`/home/asus/envs/git-new`）。上游把工作树恢复逻辑改成 `git worktree list --porcelain -z` 后需要 git 2.36 才有的 `-z` 选项；系统 git 2.34.1 报「未知开关 `z`」，`worktree.spec.ts` 与 `checkout-safety.spec.ts` 整片失败。
- 跑测试用 `LC_ALL=C`：forge 面板用例断言 git 的英文报错前缀（`fatal:`），本机中文 locale 下 git 输出「致命错误：」，13 个用例失败。
- `git fetch upstream master --tags` 会被拒四个标签（`dsh-v0.1.1-rc.2`、`dsh-v0.2.1-rc.2`、`dsh-v0.2.1-rc.3`、`dsh-v0.2.1-rc.4`）：fork 自己的同名标签与上游指向不同提交，fetch 为避免覆盖而拒绝；新的发布标签（如 `dsh-v0.2.2-alpha.2`）正常取回。

## 验证结果

- `pnpm run typecheck` 5 门、`build:artifacts` 8 门、`build:check` 2 门全过。
- `pnpm run doc-sync` 43 门全过；`pnpm run test:docs` 21 门全过。
- `pnpm run test`（Node 24 + git 2.56 + `LC_ALL=C`）：51994 项通过、54 项失败。其中 35 项在 fork HEAD 同环境同样失败（`fork-delivery` 14、`subagent-pi` 8+1、`core/agent` 3、`locale-dictionary-parity` 2、`vfs-example-fixture` 2、`webworker-packer/preview` 1、`ui-theme/hover-styles` 1、桌面两条强制更新策略用例 2、`http-proxy/install` 1）；其余 19 项是并发负载下的 5 秒超时，隔离运行同一批文件全绿。
- `pnpm run test:expected`：133 项中 1 项失败，即 `apps/cli` 的 `subagent-inheritance`（fork 自研 ssh/sftp/a2a 工具不在记录的期望里），HEAD 同样失败。
- `pnpm run test:snapshot`：合并后 4 个文件 199 项失败，fork HEAD 同 4 个文件 193 项失败，属 [会话格式 v5 落地](session-format-v5-landing.md) 记下的「快照道需按 v5 写入器全量刷新并评审」遗留，本轮不扩大。
- Web 快照道（`DSH_EXAMPLE_MODE=lib`）：合并后 7 项失败，与 HEAD 的 7 项同一批用例；3 份冲突的 `system-prompt.expected.md` 取上游后 replay 直接通过。
- Web 插件页：`plugin-manager.e2e.ts` 与 `plugin-config.e2e.ts` 先 4 项失败（golden 缺 fork 的浏览器自动化/计算机操作卡片），`DSH_SNAPSHOT=refresh` 重录 4 份 golden 后 replay 全绿（33 项）。
- `pnpm run lint`：75 条既有红项，本轮改过的 13 个文件均无红项。
- `pnpm run hygiene` 的 4 个门（`verify-product-use`、`verify-runtime-closure`、`verify-cordis-config`、`verify-no-unknown-casts`）合并前后失败集合逐条相同（只有行号位移），未新增债务。

## 分支与推送

合并在本工作树（detached HEAD 与 `develop` 同点）完成并验证，快进 `develop` 与 `master` 到同一合并提交后推送 `me`。

## 与既有知识的关系

- 沿用 [合并上游决策](../decisions/2026-09-upstream-sync.md) 的按来源取舍与生成物重生成；本轮新增两类判定见该页「后续轮次」。
- 与 [2026-10-27 合并记录](upstream-merge-2026-10-27.md) 同属「上游给核心接口加必需成员/完整性约束，fork 自研面必须跟着补」的形态；本轮的具体约束是 LiveShare 的端点全覆盖表。
- 环境判定口径延续 [2026-10-15 合并记录](upstream-merge-2026-10.md) 的基线工作树方法：本轮用 `north-curlew` 工作树（fork HEAD）在**同一 Node/git/locale 环境**复跑失败集，才把「合并引入」与「环境/既有债务」分开。
- 生成面与来源种类代际问题见 [会话格式代际](../concepts/session-format-generations.md)、[持久化历史分叉与来源种类补记](persistence-history-fork-repair.md)。

## 存疑或待跟进

- 最新版本已与上游同步：仓库根 `package.json` 与 `apps/desktop/package.json` 均为 `0.2.2-alpha.2`，等于上游最新发布标签 `dsh-v0.2.2-alpha.2` 的版本，`master` 落后 `upstream/master` 为 0。
- 版本对齐已补做：18 个 fork 自研包从 `0.2.1-rc.4` 改为 `0.2.2-alpha.2`（提交 `8d87fc6bdc`），`dsh` 家族全部成员现共享一个版本；做法与参数顺序的坑记在 [fork 发布流程](fork-release-dsh-0.2.1-rc.2.md)。
- `actions/attest@v4.2.2` 替换后的桌面发布工作流需要一次真实 Release 才能确认证明记录与资产摘要仍然正确。
- 快照道 4 个文件、Web 道 7 项失败仍是「按 v5 写入器全量刷新并评审」的遗留，需要单独一轮决策。
- fork 私有包在 `verify-product-use`、`verify-runtime-closure`、`verify-cordis-config` 上的红项长期存在：`browser-use`/`computer-use` 的 `cordis.patch.yml` 引用了未在自己 `package.json` 声明的实验 MCP 包，四个 fork 包缺产品运行面登记。见 [fork 自研包的门禁红项清单](fork-gate-debt.md)。
- 5 秒超时在满载并发下不可复现地出现（本轮 19 项）：`dsh-ci-test-reliability` 口径下这些用例应显式声明预算或降并发，属上游测试健壮性议题。
