---
title: 桌面未签名构建指向发布页的更新源（2026-10-27）
type: query
tags: [desktop, 自动更新, 更新源, electron-updater, github, fork]
created: 2026-10-27
updated: 2026-10-27
sources: []
status: active
---

# 桌面未签名构建指向发布页的更新源（2026-10-27）

## 问题

桌面版「检查更新」在 fork 发布的安装包里必然失败：`apps/desktop/scripts/electron-builder-config.mjs` 原先写的是 `const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(...)`，于是 GitHub Actions 用 `--unsigned` 打出来的包既没有 `app-update.yml`，也没有 `nightly*.yml` 元数据。`apps/desktop/src/update-coordinator.ts` 的 `enabled()` 要求 `resources/app-update.yml` 存在，缺它就报「this application has no packaged update source」。

需求是把检查更新指向仓库的 Release 页面。

## 设计

- 新环境变量 `DSH_DESKTOP_UPDATE_RELEASES_URL`（`resolveDesktopReleaseFeed`）：接受**带路径**的 HTTPS 目录地址，非 https、带凭据、带查询串或片段一律拒绝，未设置时返回 `undefined`。它取代不了原有的 COS 配置，只是多一条来源。
- 构建侧的判断改为：配置了该地址且**不是 unsigned 的 macOS** 时，`publish` 指向该地址（`channel` 默认 `nightly`）；否则维持原行为（unsigned 无源，签名构建走 COS）。
- unsigned 的 macOS 被排除：Squirrel.Mac 校验它要安装的代码签名，而未签名目标也不产出 updater 需要的 zip。macOS 用户继续手动下载 dmg。
- 工作流把 `DSH_DESKTOP_UPDATE_RELEASES_URL` 设为 `https://github.com/${{ github.repository }}/releases/latest/download`，并把构建产物里的 `nightly*.yml` 一并作为 Release 资产上传——updater 正是从该地址取这个文件。

## 实测证据

**地址形态**（对 fork 仓库现有 Release 实测 HTTP 状态）：

```
…/releases/download                            -> 404
…/releases/download/<文件>                      -> 404
…/releases/latest/download/<文件>                -> 200
```

因此采用 `releases/latest/download/`；`releases/download` 后不带 tag 无法定位资产，用它会让 updater 取 `nightly.yml` 时 404。

**本地 linux-x64 unsigned 真机打包**（`package-target.ts linux-x64 --unsigned` 带该环境变量，6 分钟）：

- 产物：`deepseek-harness-0.2.1-rc.3-linux-amd64-unsigned.deb`、`…linux-x86_64-unsigned.AppImage`、`nightly-linux.yml`；打包运行以 `stage-end … success:true` 结束。
- `nightly-linux.yml`：`version: 0.2.1-rc.3`；`files[]` 列出 AppImage 与 deb 的 sha512/size；`path` 指向 AppImage，其 `sha512` 与文件一致。
- 应用内 `linux-unpacked/resources/app-update.yml`：`provider: generic`、`url: https://github.com/example/dsh-studio/releases/latest/download/`、`channel: nightly`，并带上 electron-builder 计算的 updater 缓存目录名。地址末尾斜杠由 `resolveDesktopReleaseFeed` 规范化，updater 在其后拼接 `nightly-linux.yml`。
- 未生成独立 `.blockmap`（AppImage 的块映射内嵌，`blockMapSize` 已写在 yml 中），因此无需额外上传资产。

**检查**：`pnpm run typecheck` 5 门通过；`apps/desktop/tests` 165 个文件 1872 项通过、2 项失败——这两项（`desktop-policy-environment.spec.ts` 与 `macos-signature.spec.ts` 关于 local macOS 的 mandatory-update 策略）在 stash 掉本次改动后同样失败，属既有红项；oxlint 对本批改动文件 0 报错。

## 已知限制

- **依赖 Latest**：feed 走 `releases/latest/download/`，所以每次发布都必须把该版本设为仓库 Latest（不能标 prerelease），否则 Latest 指回旧版本、updater 读到旧元数据。rc.3 已按此设为非 prerelease。
- **macOS 无自动更新**：未签名只能手动下载。
- **Windows 未签名**：安装时会触发 SmartScreen 警告；`publisherName` 为空时不比对方签名证书，完整性由 yml 的 sha512 保证。
- **元数据与产物必须同发**：`nightly*.yml` 的 sha512 对应具体产物字节，发布后替换同名资产会让校验失败。

## 涉及模块

- `apps/desktop/scripts/desktop-auto-update-environment.mjs`（新增 `resolveDesktopReleaseFeed` 与类型声明 `.d.mts`）
- `apps/desktop/scripts/electron-builder-config.mjs`（unsigned 构建的 feed 判断）
- `.github/workflows/release-desktop.yml`（feed 地址、`nightly*.yml` 上传）
- `apps/desktop/src/update-coordinator.ts`（消费方，未改动）
- [发布 dsh 0.2.1-rc.3](release-dsh-0.2.1-rc.3.md)、[Linux 桌面 deb 与 Release 工作流](desktop-deb-release.md)

## 复发预防

- 给 fork 增加发布通道时，先实测目标地址的真实 HTTP 状态，不要按字面推断路径形态。
- 未签名构建要带更新源，必须同时产出并发布 electron-builder 的通道元数据；只发安装包等于没有更新源。
- 采用 `releases/latest/download/` 作为 feed 时，发布流程必须把新版本设为 Latest；把这个约束写进发布清单。