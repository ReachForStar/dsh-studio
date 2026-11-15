---
title: 发布 dsh 0.2.2-rc.4（上游 0.2.2-rc.3 之后的 fork 版本）
type: query
tags: [release, 发布, 版本对齐, 桌面安装包, libreoffice, 阻塞]
created: 2026-11-15
updated: 2026-11-15
sources: []
status: active
---

# 发布 dsh 0.2.2-rc.4（上游 0.2.2-rc.3 之后的 fork 版本）

## 问题

合并上游 `dsh-v0.2.2-rc.3` 后需要发布 fork 的新版本。家族版本已与上游最新对齐到 `0.2.2-rc.3`，但这个版本号在 npm 上已被上游占用，直接沿用会让桌面打包按版本解析依赖时取到上游包。

## 根因

桌面运行时的依赖按「包名 + 版本」安装：先有本地发布 tarball 的包集，再由 pnpm 补齐其余依赖。若 fork 的版本号与上游已发布版本相同，任何未被包集覆盖的依赖都会从 registry 解析到上游同名同版本包，与本地 tarball 混装。第一次尝试（沿 `0.2.2-rc.3` 发布）就是这样失败在 Linux 桌面包上：运行时装的 `dsh-office-kit` 是上游注册表里那份，而本地打包阶段按 `libreoffice-kit@0.2.3` 的 optionalDependencies 选中了 WASM 引擎，两边对引擎的预期不一致。

## 解法

- **版本取上游之后的号**：`pnpm run release:dsh -- 0.2.2-rc.4` 把 416 个成员（含私有清单与工作区根）统一写为 `0.2.2-rc.4`，脚本自行提交。
- **发布前校验**：`scripts/release/verify.ts --family dsh` 报告 416 个成员版本统一、发布顺序可解析。
- **构建与打包**：`pnpm run build:official`（构建记录绑定当前提交）→ `scripts/release/pack.ts --family dsh --out dist/npm`（416 个 tarball）→ `zip -9` 成 `dsh-0.2.2-rc.4-npm.tar.gz.zip`。
- **发布**：先把 `master`/`develop` 推到发布提交，再 `gh release create dsh-v0.2.2-rc.4 --latest`，桌面工作流由 `release: published` 与 `push: tags` 各触发一次，安装包与校验和由工作流附上。

## 发布结果

已发布 `dsh-v0.2.2-rc.4`（非 prerelease，仓库 Latest），资产：

- `dsh-0.2.2-rc.4-npm.tar.gz.zip`（416 个 tarball + `publish-order.txt`）
- macOS arm64 dmg 与 Windows x64 exe，各带 `SHA256SUMS-<target>` 与 `nightly*.yml`

**Linux x64 桌面包未能产出（阻塞）**：运行时冒烟转换 docx 时报 `Installed LibreOfficeKit package is incomplete: @deepseek-ai/libreoffice-kit-linux-x64-glibc`。证据链：`@deepseek-ai/libreoffice-kit@0.2.3` 的 `index.js` 内置引擎表要求 Linux 使用 `linux-<arch>-glibc` 引擎包、版本固定 `0.1.1`；该包在 npm 上不存在（`npm view` 404），`pnpm-workspace.yaml` 的 `onlyPlatformBuilds` 也只列了 darwin/win32/wasm；上游的 `desktop-publish.yml` 在自托管 Linux runner 上构建，引擎由该机器提供。fork 的 `release-desktop.yml` 跑在 `ubuntu-latest`，拿不到该引擎。

**macOS x64 首次失败**：运行期 docx/xlsx 冒烟转换报 `LibreOffice conversion timed out`（arm64 与 Windows 同一提交通过），按 `workflow_dispatch` 带 `release_tag` 重跑补齐。

## 复发预防

- 发布前先确认目标版本号在 npm 上未被上游占用；同号会让桌面运行时混装上游包，症状是引擎/依赖版本对不上，而不是安装失败。
- `build:official` 绑定当前 HEAD：先完成所有提交再构建、打包、打标签，中途任何提交都要重跑。
- `gh release create` 会同时触发 tag 推送与 release 发布两批桌面构建，属既有设计（两批用 `--clobber` 覆盖同名资产）。
- Linux 桌面包需要 `libreoffice-kit-linux-<arch>-glibc@0.1.1` 引擎；在获取该引擎（自托管 runner 预装或补发布）之前，Linux 安装包无法在公共 runner 上产出。

## 涉及模块

- 发布流程与门禁：[发布 dsh 0.2.1-rc.3（含四平台桌面安装包）](release-dsh-0.2.1-rc.3.md)、[fork 发布 rc.2 的流程与门禁踩坑](fork-release-dsh-0.2.1-rc.2.md)
- 本轮合并与其修复：[合并上游 upstream/master（2026-11-15）](upstream-merge-2026-11-15.md)、[lint 红项清零与本机测试预算](lint-debt-clearance-and-local-test-budget.md)
- 打包与引擎：`scripts/release/{verify,pack,bump}.ts`、`scripts/libreoffice-packages.mjs`、`apps/desktop/scripts/{prepare-dsh,prepare-package-set}.ts`
