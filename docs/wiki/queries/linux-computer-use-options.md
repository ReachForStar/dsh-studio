---
title: Linux 上的 computer use 方案
type: query
tags: [computer-use, cua-driver, linux, x11, 方案对比]
created: 2026-11-24
updated: 2026-11-24
sources: []
status: active
---

# Linux 上的 computer use 方案

## 问题

fork 的 `cua-bundle` 只给 macOS 与 Windows 装了 provider，Linux 上完全没有接入路径。要在 Linux 上让模型操作本机桌面，需要选一条可行方案并确认它在本机真的能跑。

## 结论

| 方案 | 组合 | 适用条件 | 本机实测 |
| --- | --- | --- | --- |
| A. 原生 SDK provider（推荐） | `@deepseek-ai/dsh-computer-use` + `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` | X11 图形会话，进程能访问该 display；glibc x64 或 arm64 | 通过：42 个工具、读到 `4480x1440` 屏幕与 10 个窗口 |
| B. MCP provider | `@deepseek-ai/dsh-computer-use` + `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` | 已装独立的 Cua Driver 应用（`curl -fsSL https://cua.ai/driver/install.sh \| bash` 或面板安装按钮），权限与执行归该应用 | 未测（需外部安装与网络） |
| C. 浏览器车道 | `browser-use` 的 playwright / chrome-devtools MCP | 只需要网页自动化 | 已有 Chromium，属另一条能力 |

方案 A 的原生二进制由 npm 可选依赖提供：`@trycua/cua-driver-linux-x64-gnu@0.28.0` 携带 `cua_driver_node_runtime.node` 与 `libcua_driver_sdk.so`（`libc: glibc`）。`packages/experimental/computer-use-cua-driver-native` 没有自带 `native/` 目录，不要按「需要自行编译原生 helper」处理。

## 实测证据（本机 Linux，`XDG_SESSION_TYPE=x11`、`DISPLAY=:0`）

- 仓库自带的自检：`env -u NODE_USE_ENV_PROXY DSH_COMPUTER_USE_NATIVE_E2E=1 node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts packages/experimental/computer-use-cua-driver-native/tests/native.e2e.ts` → 1 项通过（加载 SDK、`check_permissions` 不弹窗、卸载）。
- 工具目录（在包目录内以 tsx 起同一套插件组合）共 42 个：`cua_driver_native__list_apps`、`list_windows`、`get_window_state`、`get_accessibility_tree`、`click`／`double_click`／`right_click`／`drag`／`scroll`、`type_text`／`press_key`／`hotkey`、`clipboard_read`／`clipboard_write`、`get_screen_size`、`get_desktop_state`、`launch_app`／`kill_app`／`bring_to_front`、`zoom`、`browser_*`（8 个）、`start_recording`／`replay_trajectory`、`start_session`／`escalate_session`／`end_session` 等。
- 桌面读取真实返回：`get_screen_size` → `Main display: 4480x1440 points @ 1x`（左右两块屏组成 4480 逻辑宽度）；`list_windows` → 10 个窗口，带 `xid`、`pid` 与几何（如 `[xid=81788981] pid=Some(2548606) "微信" 1725x970+2310+219`）。

截图要落到附件才有用：provider 把图像交给 MCP 结果适配器，模型路由必须显式声明 image 输入，宿主还要有 attachment store。本机 Pi 网关的 `qwen3.8-flash-next-iq3_s` 在 `/v1/models` 里声明 `input_modalities: ["text","image"]`，满足该条件。

## fork 侧缺口

- `packages/experimental/cua-bundle/cordis.patch.yml` 只挂 `cua-macos`（`darwin`）与 `cua-windows`（`win32`），并把客户端 `ui-cua` 面板在非这两平台上禁用，注释写明「No Linux provider exists」。因此 Linux 想用方案 A，需要自备 overlay（只装 `dsh-computer-use` 与原生 provider），而不是复用 `cua-bundle`。
- 权限页依赖 `cuaAccess` 服务（由 `cua-macos`／`cua-windows` 提供）；Linux 没有该服务，也没有 TCC 式授权，面板不存在属预期。若要给 Linux 一等支持，需要决定权限页呈现（大概是「无需授权」状态），而不是直接复用 macOS 的权限轮询。
- 原生运行时与宿主同进程：原生崩溃会带走宿主进程。要求稳定隔离时选方案 B（执行与权限归独立应用）。

## 复发预防

- 判断 Linux 能否用时，先看 `node_modules/.pnpm/@trycua+cua-driver-linux-*` 是否存在，再跑上面那条自检；不要从包内有没有 `native/` 目录推断。
- 只在 X11 会话下验证过；Wayland 合成器下窗口是否可见尚未验证（待核验：先看 `echo $XDG_SESSION_TYPE`，再用 `list_windows` 观察是否只列到 XWayland 应用）。
- 覆盖率豁免里 CUA 那 4 个文件与本条无关：平台包已就位，缺的是面板分支的浏览器车道用例。