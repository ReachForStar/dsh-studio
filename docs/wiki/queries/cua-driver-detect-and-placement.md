---
title: Cua Driver 检测补全与入口迁移（2026-10-27）
type: query
tags: [cua, computer-use, 检测, 安装, 插件页, fork]
created: 2026-10-27
updated: 2026-10-27
sources: []
status: active
---

# Cua Driver 检测补全与入口迁移（2026-10-27）

## 问题

用户反馈 Cua Driver 安装检测有问题，且安装入口放错了位置。核实后两处都属实：

- 检测只对裸命令跑 `--version`，按退出码判定；本机 `cua-driver 0.36.0` 在 `~/.local/bin` 且已在 PATH 内，但安装器写入的用户目录不在进程继承的 `PATH` 里时（安装后未重登录 shell，桌面应用尤其常见），检测会误报未安装。
- 检测/安装组件 `CuaDriverInstall` 挂在插件卡片 footer（`@deepseek-ai/dsh-computer-use` 卡片），不在「计算机操作」详情页。

## 根因与修法

- **检测路径不全**（`packages/experimental/computer-use-cua-driver-mcp/src/installer.ts`）：`checkDriver` 只信任 `PATH`。改为 `resolveDriverExecutables` 依次探测：命令本身 → 安装器写入的稳定路径（Unix `~/.local/bin/cua-driver`、`~/.cua-driver/packages/current/cua-driver`；Windows `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\cua-driver.exe` 与 `.cua-driver/packages/current`），按 `fs.constants.X_OK` 判定可执行。绝对路径配置优先，不再探测其它位置。
- **check 路由回报 `path`**：`/api/computer-use/cua-driver/check` 返回 `{ installed, version, path }`，页面显示实际生效的可执行文件，用户能看见意料之外的分辨结果。
- **入口迁移**：`CuaDriverInstall` 重写为 `CuaDriverSetup`，从卡片 footer 移到 `@deepseek-ai/dsh-computer-use` 的详情页（`data-plugin-setup` section）；安装成功后自动重检（`check` 复用同一路径解析），不再要求重启。
- **文案**：`cuaDriverInstalled`（要求重启）替换为 `cuaDriverPresent`/`cuaDriverRecheck`/`cuaDriverProgressLabel`，八个语言同步补齐（`locale-dictionary-parity` 门禁要求键集与 `en` 一致）。

## 涉及的既有事实纠正

早前把「组件用裸 `fetch('/api/...')`」记成缺陷，经核实 `/api` 前缀的精确 Fetch route 由 `packages/client/connection` 承载，`computer-use-cua-driver-mcp` 注册的 `/api/computer-use/cua-driver/{check,install}` 正是正确的既有通道；真正的缺陷是检测路径不全与入口位置，不是传输方式。

## 验证

- `packages/experimental/computer-use-cua-driver-mcp/tests/installer.spec.ts`：5 项通过（PATH、安装器自有位置、绝对路径、Windows 带空格路径、无 PATH 的可执行）。
- `composition.spec.ts` 增 2 项：驱动未安装时仍注册 check 路由并据实报告；check/install 两条路由并存。
- `ui-plugin-manager/tests/components.client.spec.tsx` 增 2 项：驱动在包详情页展示（不在卡片），缺失时给出安装按钮。
- typecheck 5 门全绿；改动文件 lint 清零（`installer.ts` 的 5 条为 HEAD 既有，本次一并修掉）。

## 涉及模块

- [`computer-use-cua-driver-mcp`](../../../packages/experimental/computer-use-cua-driver-mcp/README.md)：检测、安装、MCP provider。
- [`ui-plugin-manager`](../../../packages/client/ui-plugin-manager/README.zh.md)：插件管理页与详情页。
- [星域多智能体](../entities/xingchen-multi-agent.md)（同批改动的另一主题）。

## 复发预防

检测可执行文件时要覆盖安装器写入的稳定路径，不能只信任进程继承的 `PATH`——桌面应用在安装后不经登录 shell 重启，`PATH` 里没有新装目录。用户可见的「已安装」状态应展示实际解析到的可执行文件路径，把意外的分辨结果暴露出来而不是藏成一句「已安装」。
