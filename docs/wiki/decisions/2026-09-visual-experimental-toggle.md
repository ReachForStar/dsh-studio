---
title: 实验能力可视化开关：沿用上游 OPTIONAL_BUNDLES 模式
type: decision
tags: [实验插件, 插件管理, web-ui, optional-bundles]
created: 2026-09-18
updated: 2026-09-18
sources: []
status: active
---

# 实验能力可视化开关：沿用上游 OPTIONAL_BUNDLES 模式

## 背景（现状与约束）

fork 的实验能力（Browser Use / Computer Use / Auto review）此前只能在用户侧 profile（`~/.dsh/profiles/web-lab/`）的 `cordis.patch.yml` 里手工插入行启用，Web UI 无任何入口。上游合并（2026-09-18，882 提交）带来了完整的插件管理栈：

- `dsh-plugin-manager`（`packages/boot/plugin-manager`，host 侧）：托管 profile 的 bundle 选择（`package.json` 的 `dsh.profile.bundles`）与行启停（`cordis.patch.yml` 的 `disabled` 覆盖），含安装/卸载 pnpm 流程。
- `ui-plugin-manager` + `ui-settings-plugin-inventory`（client 侧，已随上游并入 `web-app` 组合）：Web 侧边栏 **Plugins** 页；**Official** 组列出「安装自带、默认关闭」的 bundle（`OPTIONAL_BUNDLES`，定义在 `packages/boot/app-boot/src/profile.ts`），带 Beta 标签，可一键开关。
- 上游 Agent Note（`.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md`）定下规则：可选 bundle 必须是 `apps/cli` 的运行时依赖、声明 `dsh.bundle.patch`、且不被任何出厂 profile 模板选中；静态门禁（default-product-isolation、workspace-constraints、packed-install）读取同一列表放行依赖边。

## 备选方案（各方案优劣）

- **A. 扩 `OPTIONAL_BUNDLES` + 把实验能力包变成 bundle**：复用上游全套 UI/托管/门禁，新增面只有每能力一个 `cordis.patch.yml` + package.json 的 `dsh.bundle` 字段 + 列表登记。代价：能力包从「纯插件行」变为「bundle + 行」双重身份（直接挂载行时 bundle patch 不生效，互不干扰）。
- **B. 自研 Lab 开关（fork 自己的 settings 节 + 写 profile patch）**：与上游插件管理两套机制并存，UI、托管、门禁全要自造，且下个上游同步必撞车。
- **C. 只做文档指引（教用户抄 web-lab 行）**：零代码但不满足「可视化」需求。

## 决策（选定方案）

选 A。三个实验能力各自成为可选 bundle，全部登记进 `OPTIONAL_BUNDLES` 与 `apps/cli` 依赖：

| bundle | 包 | patch 层插入的行 |
| --- | --- | --- |
| `@deepseek-ai/dsh-browser-use` | `packages/browser-use/browser-use` | `browser-use`（能力服务）+ `browser-use-playwright`（Playwright MCP，默认 launch/isolated Chromium，零配置） |
| `@deepseek-ai/dsh-computer-use` | `packages/computer-use/computer-use` | `computer-use`（能力服务）+ `computer-use-cua`（Cua Driver MCP，`command` 缺省走 PATH 的 `cua-driver`） |
| `@deepseek-ai/dsh-experimental-auto-review` | 已是 bundle，仅登记 | `auto-review` |

配套：`ui-plugin-manager` 的 `BUILTIN_COPY`（presentation.ts）与 `locales.ts`（en/zh）补 browser-use / computer-use 的标题、描述与 Beta 标记；两能力包 README frontmatter `kind` 改 `package-bundle`（doc-standard 门禁按 bundle 身份校验）。

用户模型（provider 网关、cua-driver 路径）等**用户专属配置不进 bundle**——bundle patch 只含能力行与零配置默认值；用户的 pi-agent-loop/model 配置仍留在各自 profile 的 patch 层（与 web-lab 现状一致）。

## 理由（决策依据）

- 上游为「安装自带、默认关闭、可一键开启」设计的机制正是 OPTIONAL_BUNDLES，UI/托管/门禁/文档全链已就绪，fork 只需登记，同步成本最低。
- bundle patch 的零配置默认值（Playwright launch、cua-driver 走 PATH）覆盖了 web-lab 里除用户专属项外的全部行；缺失外部依赖时该行激活失败、组合其余照常（与 web-lab 既有行为一致），不会拖累默认 `web` profile。
- 与出厂隔离门禁相容：三个名字登记后，门禁放行 `apps/cli` 的依赖边，且出厂模板（base/web-app）不选中它们——默认组合的实验隔离 smoke 不受影响。

## 后果（影响与后续）

- `web` 等托管 profile 的 Web **Plugins** 页 Official 组出现三个 Beta bundle；开关写入 profile 的 `dsh.profile.bundles`，HMR profile 即时生效、否则下次启动生效。
- web-lab 用户可逐步迁移：删除手工行、改用插件页开关（模型配置行保留）。
- 上游若日后把 auto-review 等也登记为可选 bundle，`OPTIONAL_BUNDLES` 列表是下一轮同步的冲突点（按上游意图合并即可，fork 无额外逻辑）。
- 验证：`pnpm dsh --profile <临时profile> --dump-config` 确认三 bundle 解析、行插入、无激活告警（2026-09-18 已验证）；plugin-manager/app-boot/ui-plugin-manager 相关测试 402 条全绿。
