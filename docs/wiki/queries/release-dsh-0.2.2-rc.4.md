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
- macOS arm64/x64 dmg 与 Windows x64 exe，各带 `SHA256SUMS-<target>` 与 `nightly*.yml`

**Linux x64 桌面包改为本地打包上传**：CI 的 `ubuntu-latest` 上运行时冒烟报 `Installed LibreOfficeKit package is incomplete: @deepseek-ai/libreoffice-kit-linux-x64-glibc`。`@deepseek-ai/libreoffice-kit@0.2.3` 的引擎表要求 Linux 使用 `linux-<arch>-glibc` 引擎包（版本固定 `0.1.1`），该包在 npm 上不存在（`npm view` 404），`pnpm-workspace.yaml` 的 `onlyPlatformBuilds` 也只列 darwin/win32/wasm；上游在自托管 Linux runner 上构建。本地构建没有该引擎包，kit 按设计回退到 WASM，冒烟通过——因此改为在本机打包后手工上传（详见下节）。

**macOS x64 首次失败后重跑通过**：首次运行期冒烟转换报 `LibreOffice conversion timed out`（arm64 与 Windows 同一提交通过），按 `workflow_dispatch` 带 `release_tag` 重跑后该目标成功并附上 dmg 与校验和；同一重跑里 Linux 仍失败，与上述引擎缺失一致。

## 本地打包 Linux 桌面包的过程

本机（Linux x64）跑 `apps/desktop/scripts/package-target.ts linux-x64 --unsigned` 需要三处本机适配，缺一失败：

1. **pnpm 入口**：脚本用 `node $npm_execpath` 调 pnpm，而本机 pnpm 是独立二进制（`@pnpm/exe`），node 会把 ELF 当 JS 解析并报 `SyntaxError: Invalid or unexpected token`。用一个 `.cjs` 垫片转发到真实二进制，并把 `npm_execpath` 指向它。
2. **代理**：`prepare:runtime` 用 `@electron/get` 下载 Electron，Node 24 的内置 `fetch` 不看 `http_proxy`/`https_proxy`，需 `NODE_USE_ENV_PROXY=1`（否则 `TypeError: fetch failed`）。
3. **非 ASCII 路径**：Electron 的 asar 支持读不了含非 ASCII 的路径，打包末段的 `smoke-packaged-runtime` 会报 `ENOTDIR: … app.asar/dsh/desktop-runtime.json`。整条流程的 ESM 模块路径会被 realpath 回真实路径，符号链接绕不过去；做法是把 `linux-unpacked` 与测试夹具复制到 ASCII 临时目录后，用同一命令重跑冒烟校验（本机实测该冒烟退出码 0，包含 docx/xlsx/pptx 的 Office 转换）。
4. **网络被墙时的两个镜像**：`prepare:runtime` 的 Electron 下载走 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（缓存命中时 `@electron/get` 仍会校验远端）；`prepare:dsh` 的运行时安装走 `DSH_DESKTOP_NPM_REGISTRY=https://registry.npmmirror.com`（`registry.npmjs.org` 直连超时会报 `ERR_PNPM_META_FETCH_FAIL`）。同源 tarball 与 lockfile 完整性校验仍生效。
5. **本机安装**：`pkexec dpkg -i <deb>` 走桌面 polkit 弹窗授权（`sudo -n` 在本机需要密码、无法非交互），装完 `dpkg -s deepseek-harness` 应为 `0.2.2~rc.4`，二进制落在 `/opt/DeepSeek Harness/deepseek-harness`，`/usr/bin/deepseek-harness` 由 `update-alternatives` 指向它。

产物落点 `apps/desktop/.desktop-build/targets/linux-x64/unsigned-artifacts/`：`deepseek-harness-0.2.2-rc.4-linux-amd64-unsigned.deb`、`deepseek-harness-0.2.2-rc.4-linux-x86_64-unsigned.AppImage`。校验和按工作流同款格式（`<sha256>  <文件名>`）写到 `SHA256SUMS-linux-x64`，随后 `gh release upload --clobber` 三个文件。本地无 Sigstore 证明能力，Linux 这两件没有 `actions/attest` 覆盖，其余 mac/win 资产仍有。

## 复发预防

- 发布前先确认目标版本号在 npm 上未被上游占用；同号会让桌面运行时混装上游包，症状是引擎/依赖版本对不上，而不是安装失败。
- `build:official` 绑定当前 HEAD：先完成所有提交再构建、打包、打标签，中途任何提交都要重跑。
- `gh release create` 会同时触发 tag 推送与 release 发布两批桌面构建，属既有设计（两批用 `--clobber` 覆盖同名资产）。
- Linux 桌面包需要 `libreoffice-kit-linux-<arch>-glibc@0.1.1` 引擎；公共 runner 拿不到时在本机打包上传，并保留「asar 读不了非 ASCII 路径」「Node fetch 不看代理」「本机 pnpm 是二进制」三条本机前置。
- 本机手工上传的资产没有 Sigstore 证明；需要证明时改用自托管 Linux runner 或在 CI 里补 `actions/attest` 覆盖手工资产。

## 涉及模块

- 发布流程与门禁：[发布 dsh 0.2.1-rc.3（含四平台桌面安装包）](release-dsh-0.2.1-rc.3.md)、[fork 发布 rc.2 的流程与门禁踩坑](fork-release-dsh-0.2.1-rc.2.md)
- 本轮合并与其修复：[合并上游 upstream/master（2026-11-15）](upstream-merge-2026-11-15.md)、[lint 红项清零与本机测试预算](lint-debt-clearance-and-local-test-budget.md)
- 打包与引擎：`scripts/release/{verify,pack,bump}.ts`、`scripts/libreoffice-packages.mjs`、`apps/desktop/scripts/{prepare-dsh,prepare-package-set}.ts`
