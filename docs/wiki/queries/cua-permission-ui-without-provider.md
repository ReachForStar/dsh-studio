---
title: CUA 权限页在无提供方宿主上报服务缺失（2026-11-15）
type: query
tags: [cua, computer-use, typert-remote, 客户端, 缺陷修复]
created: 2026-11-15
updated: 2026-11-15
sources: []
status: active
---

# CUA 权限页在无提供方宿主上报服务缺失（2026-11-15）

## 问题

在安装并启用 Computer Use 组合包的宿主上，权限页的应用图标区显示：`无法读取应用图标：typert gateway: cuaAccess/applicationIcons: active Service "cuaAccess" is unavailable`。实际上同一页面的四项查询（默认模式、执行方式、系统权限、应用列表/图标）都会各自报同一句网关诊断。

## 根因

`cua-bundle` 的补丁在**所有平台**都挂载 `ui-cua`（客户端权限页），而原生提供方 `cua-macos`（`darwin`）与 `cua-windows`（`win32`）按平台禁用，共享的 `CuaAccess` 服务由提供方构造。没有提供方的宿主（Linux）因此出现「远端定义存在、宿主服务不存在」的组合：

- 网关按端点解析服务，`ctx.get('cuaAccess')` 为空即返回 `gateway/service-unavailable`（`active Service "cuaAccess" is unavailable`）；
- 客户端控制器把每次查询失败都写进对应分区的 `error`，四个分区各显示一遍同样的网关文字，用户看到的就是图标区那条。

## 解法

1. **组合层按平台门控客户端页**：`packages/experimental/cua-bundle/cordis.patch.yml` 的 `ui-cua` 加 `disabled: !!js process.platform !== 'darwin' && process.platform !== 'win32'`，与两个提供方同口径——没有提供方的宿主不再渲染这张页面。`platform.spec.ts` 改为断言 `dsh-cua` 只在 darwin/win32 被导入。
2. **客户端把「服务缺失」当作组合事实**：`PermissionController` 新增 `serviceUnavailable` 状态，查询或操作失败且错误码为 `gateway/service-unavailable` 时置位，并清空分区 `error`；`PermissionPanel` 在该状态下只渲染一条说明（新增本地化键 `serviceUnavailable`，8 种语言），不再列四个分区失败。这覆盖了受支持宿主上提供方加载失败（例如原生 helper 未就绪）的同一类情形。

## 验证

```bash
pnpm exec vitest run packages/experimental/cua packages/experimental/cua-bundle   # 855 通过 / 3 跳过
pnpm run typecheck          # 5 门
pnpm run lint               # 0 error
pnpm run build:artifacts && pnpm run build:check
pnpm run test:docs          # 21 门（含双语配对重记）
```

新增用例：控制器「缺服务时只置一次组合事实、不清分区错误为失败」、面板「缺服务时只渲染一条说明且不渲染系统分区」。

## 复发预防

- 提供方私有服务（`cuaAccess`、平台 helper 一类）的客户端页面必须与提供方**同口径门控**，不能在所有平台按共享定义挂载。
- 远端方法失败要区分「组合错误」（服务缺失、上下文缺失）与「分区失败」：前者属于整页事实，逐区重复网关文字只会误导使用者。
- 组合包补丁的平台门控与客户端可见性要成对改动，并同步 `platform.spec.ts` 与双语 README。

## 涉及模块

- [Computer Use 子系统](../../../docs/subsystems/computer-use.md)、`packages/experimental/cua`（`src/client/controller.ts`、`src/client/PermissionPanel.tsx`、`src/client/locales.ts`）
- `packages/experimental/cua-bundle`（`cordis.patch.yml`、`tests/platform.spec.ts`、双语 README）
- 网关错误码 `gateway/service-unavailable`（`packages/api/gateway/src/index.ts`）
