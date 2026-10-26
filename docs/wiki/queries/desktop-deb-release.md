---
title: Linux 桌面 deb 安装包与 Release 工作流
type: query
tags: [desktop, deb, release, linux]
created: 2026-10-21
updated: 2026-10-27
sources: []
status: active
---

# Linux 桌面 deb 安装包与 Release 工作流

## 问题

为 Ubuntu x86_64 生成并安装 0.2.1-rc.2 桌面安装包，在 GitHub Release 流程增加桌面构建。

## 根因

Linux electron-builder 配置只声明 AppImage；本地无发布服务配置时无法启动现有 Linux 打包流程。现有工作流没有通用的桌面 GitHub Release 构建任务。

## 解法

Linux 同时生成 AppImage 与 amd64 deb，deb 包名为 `deepseek-harness`。未指定机器 preset 的显式 `--unsigned` 构建在各平台使用独立本地环境，不读取发布配置或内置更新服务；机器 preset 的策略配置仍需校验。deb 通过系统包管理器升级。

`.github/workflows/release-desktop.yml` 支持手动构建与 Release published 事件；发布标签必须等于源码的 `dsh-v<version>`。工作流使用 Linux x64、Windows x64、macOS arm64/x64 四目标矩阵，保存 AppImage/deb、EXE、DMG 安装包，发布事件还会上传到对应 Release。Windows 不签名，macOS 不执行 Developer ID 签名或 Apple 公证。COS 发布仍由原工作流负责。

运行时补丁规则明确允许 pi 后端使用未打补丁的 `pi-ai 0.84.4`，上游适配器仍固定到带补丁的 `1.1.0`；其余未审核版本继续拒绝。真实运行时锁文件已通过校验，故意提供错误补丁版本时拒绝。独立运行时安装沿用仓库 SSH 权限：`ssh2: true`、`cpu-features: false`。

ASAR 内不存在的目录在 Electron 的 `lstatSync(..., { throwIfNoEntry: false })` 下返回 `null`，Office 库用 `!== undefined` 判断时误报原生引擎不完整。Host 将 Office 入口 JavaScript 与原生引擎一起解析到 `.asar.unpacked` 的实际目录，避免在 ASAR 路径进行引擎存在性检查。修复由打包后真实 Office 转换验证。

## Release 桌面包三触发与补传（2026-10-27）

`release-desktop.yml` 改为三个触发共用同一 tag 解析（`RELEASE_TAG`）：

- `release: published` —— fork 的 `dsh-v*` Release，构建并附上四个目标产物。
- `push: tags: dsh-v*` —— 发布流程有时先创建 Release 再构建产物，tag 推送是独立触发而不是第二个手动步骤。
- `workflow_dispatch` 的 `release_tag` —— 给一个已存在的 Release 补传桌面安装包（`--clobber` 覆盖同名资产），用于「Release 已建但缺安装包」的补发。

attach 步骤按矩阵条目声明的实际产物收集（`{deb,AppImage,exe,dmg}`），并对每个 target 校验非空；`Validate release version` 仍要求 tag 等于 `dsh-v<版本>`。此前的两个坑（Windows GNU tar 读盘符路径失败、macOS arm64 独立成功）已在本页上文记录；产物仍落在 `apps/desktop/.desktop-build/targets/<target>/unsigned-artifacts/`。

## 验证

- 本地 Linux unsigned 预检通过。
- Linux 打包、环境校验、目标参数与补丁准备 58 项、Windows 相关配置与参数 59 项、Office 解析 10 项测试通过，共 127 项。
- `build:check` 两项检查通过。文档检查 43 项全部通过。
- 全库 lint 在未修改文件中失败；本次文件专项 lint 通过。
- 组装后的真实应用完成 Node/原生模块/终端/搜索/离线插件及 DOCX、XLSX、PPTX 转 PDF 验证。
- deb 已生成：包名 `deepseek-harness`、版本 `0.2.1~rc.2`、架构 `amd64`，应用目录 `/opt/DeepSeek Harness`。安装包与 SHA256SUMS 保留在 `dist/desktop/0.2.1-rc.2/`。
- 首次系统安装成功：`deepseek-harness 0.2.1~rc.2 amd64 install ok installed`。实际启动发现 ui-polish 发布缺少客户端分片，修复见 [共享 runtime 排查](cjs-client-shared-runtime-chunk.md)。修复后的真实 ASAR 页面进入工作台，控制台无错误；修复包已覆盖安装，系统桌面入口的 StartupWMClass 已更新为 deepseek-harness。
- [四平台 Actions 首次运行](https://github.com/ReachForStar/dsh-studio/actions/runs/39563648636)已触发，Linux x64 与 macOS Intel 已成功，Windows 在 GNU tar 读取盘符路径时失败，macOS arm64 也已成功。Windows 包集合读取改为复用跨平台 tarball helper，修复后的远端结果待核验。

## 涉及模块

- [桌面打包指南](../../../apps/desktop/packaging/README.zh.md)
- [既有 fork 发布流程](fork-release-dsh-0.2.1-rc.2.md)

## 复发预防

保留 AppImage 目标，避免改变现有更新文件格式；Linux 本地构建不得用虚构服务配置通过校验。安装结论必须以系统包状态和实际启动为依据。

## Linux 图标

Linux 从蓝色鲸鱼 `apps/desktop/resources/icon-linux.svg` 生成 16、24、32、48、64、128、256、512 像素 PNG，交由 builder 安装到 hicolor 对应尺寸目录。应用清单声明 `desktopName: deepseek-harness.desktop`，Linux 开启 `syncDesktopName`，保持桌面入口、图标与运行窗口标识一致。

## 发布包验收

`prepare:packages` 在安装前使用现有 tar 库和 `prologueRequires` 检查同步 `client.*.js` 文件。旧版真实 ui-polish tarball 因缺少 runtime 被拒绝；补齐发布清单的真实 tarball 通过。此检查用于阻止后端检查通过但客户端无法激活的安装包继续生成。

本轮修复验证：完整构建 9 项通过，后续脚本类型检查 2 项通过，包集合与本地打包测试 11 项通过，包元数据检查通过；完整真实桌面包集合通过新增客户端分片检查。仓库全量约束检查仍报告既有依赖协议和实验包引用问题，本次没有修改这些依赖定义。

- [修复后的四平台 CI](https://github.com/ReachForStar/dsh-studio/actions/runs/39567304425)四个平台均已成功。新版本地 deb 与 AppImage 的 SHA256 校验通过；客户端修复包已安装，蓝色鲸鱼图标包已生成并通过 SHA256 校验，deb 内 512 像素图标与源 PNG 完全一致，蓝色图标版覆盖安装终端等待用户认证。
- 按用户授权清理旧清单的 47 个临时路径；升级仍需使用的 5 项保留在 `tmp/desktop-temporary-paths.txt`，本轮新增调试文件未获删除授权。

## 2026-10-26 重打包：两个网络坑与解法

同版本 `0.2.1-rc.2` 重打包以带上 A2A 状态页的 Kafka 修复（[来龙去脉](desktop-a2a-kafka-unavailable.md)）。构建本身无改动，失败全在下载环节。

**坑一：Electron 下载被 `https_proxy` 拖垮。** 本机 `https_proxy=http://127.0.0.1:7890`，该代理直连失败（`curl -x` 对该 URL 返回 000），但**不走代理直连 npmjs 稳定 200**。`prepare-dsh` 的 `runPnpm` 会清掉 `npm_*`/`pnpm_*` 与 `DSH_DESKTOP_*` 变量，却保留 `https_proxy`，于是 pnpm 走坏代理后大量 `ECONNRESET`。解法：打包命令前 `env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u all_proxy -u ALL_PROXY`。

**坑二：`@electron/get` 的 SHASUMS 格式。** 断网时缓存里的 `electron-v44.7.0-linux-x64.zip` 仍需联网取 `SHASUMS256.txt` 校验，因此准备本地镜像。三处须与库实现对齐，否则反复失败：

- **URL 形态**是 `${ELECTRON_MIRROR}${ELECTRON_CUSTOM_DIR}/${file}`，`customDir` 默认是**版本号本身（不带 v）**；写成 `/v44.7.0/` 会 404。对应设置 `ELECTRON_MIRROR=http://127.0.0.1:8899/` 与 `ELECTRON_CUSTOM_DIR=44.7.0`。
- **SHASUMS 行格式**受 `sumchecker` 的正则 `/^([\da-fA-F]+) ([ *])(.+)$/` 约束：哈希后必须是**一个空格加一个标记字符**（`*` 或空格），再跟文件名。写两个空格会让第二空格被当成标记，报 `ChecksumMismatchError`。照官方格式写 `hash *filename`。
- **校验和要真算**：从 zip 现算 sha256，不写伪造值；`zip` 完整性另用 `unzip -t` 核。

产物落 `dist/desktop/0.2.1-rc.2/`（git 忽略），并生成新的 `SHA256SUMS`。安装需 sudo，非交互环境无法完成，留给用户执行。
