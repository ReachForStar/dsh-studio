---
title: Linux 桌面 deb 安装包与 Release 工作流
type: query
tags: [desktop, deb, release, linux]
created: 2026-10-21
updated: 2026-10-21
sources: []
status: draft
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

## 验证

- 本地 Linux unsigned 预检通过。
- Linux 打包、环境校验、目标参数与补丁准备 58 项、Windows 相关配置与参数 59 项、Office 解析 10 项测试通过，共 127 项。
- `build:check` 两项检查通过。文档检查 43 项全部通过。
- 全库 lint 在未修改文件中失败；本次文件专项 lint 通过。
- 组装后的真实应用完成 Node/原生模块/终端/搜索/离线插件及 DOCX、XLSX、PPTX 转 PDF 验证。
- deb 已生成：包名 `deepseek-harness`、版本 `0.2.1~rc.2`、架构 `amd64`，应用目录 `/opt/DeepSeek Harness`。安装包与 SHA256SUMS 保留在 `dist/desktop/0.2.1-rc.2/`。
- 系统安装与启动：已打开交互终端，等待用户输入 sudo 密码。
- 远端 Actions 执行：待核验。

## 涉及模块

- [桌面打包指南](../../../apps/desktop/packaging/README.zh.md)
- [既有 fork 发布流程](fork-release-dsh-0.2.1-rc.2.md)

## 复发预防

保留 AppImage 目标，避免改变现有更新文件格式；Linux 本地构建不得用虚构服务配置通过校验。安装结论必须以系统包状态和实际启动为依据。
