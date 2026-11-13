---
title: 客户端域分层与包元数据门禁（2026-11-13）
type: decision
tags: [门禁, 客户端, 依赖, 国际化, 包元数据]
created: 2026-11-13
updated: 2026-11-13
sources: []
status: active
---

# 客户端域分层与包元数据门禁（2026-11-13）

## 背景

fork 新增的客户端与实验包让四个门禁长期变红，且没有记录取舍：

- `verify-client-domain-graph` 报告 101 条：域目录互相导入、顶层文件直接导入域；其中大量是样式表与图片导入，以及真实的分层 DAG（`docx`/`pptx` → `office`、`office` → `pdf`、`image`/`pdf` → `zoom`、`skeleton` → `input`、`view` → `browser`）。
- `verify-cordis-config` 报告两条：`browser-use` 与 `computer-use` 的 bundle patch 引用实验提供方，但清单未声明。
- `verify-locale-metadata` 因 btw 的 `Partial<Config>` 配置声明无法解析而中断；修复后又暴露 10 个实验包与新的 MCP 设置页缺少 8 语言元数据。
- `pnpm run constraints` 同时报告版本、`files`、`workspace:` 范围、实验名例外与 web-app 依赖实验包等多项。

## 备选方案

- **重构到单一 `contract/`**：把每个包的共享层全部搬进 `contract/`。彻底但改动面大，且把 UI 组件搬进契约层在语义上不成立。
- **允许任意无环域导入**：规则简单，但失去“共享 API 走契约”的约束，等价于放弃门禁。
- **按包声明分层**：新增 `src/client/layers.json`，声明额外的 `shared` 目录与有向 `edges`；未声明的边仍然失败，声明图必须无环。

## 决策

1. 门禁忽略资源导入（样式表、图片、字体、音视频），并支持按包声明 `layers.json`。
2. 真实存在的分层 DAG 用 `edges` 声明；`ui-sidebar-browser` 的 `browser` ↔ `view` 环通过把 `BrowserPresentation` 契约移入 `contract/`、把 `IframePresentation` 归入 `browser` 域消除。
3. `OPTIONAL_BUNDLES` 中的 bundle 可以依赖它要交付的实验提供方（默认安装仍不包含该 bundle）。
4. Web 产品包 `dsh-web-app` 明确允许 8 个实验能力依赖，名单写在 `scripts/check-workspace-constraints.ts`。
5. btw 的配置输入声明为具名 `ConfigInput`，不再使用 `Partial<Config>`；每个插件包补齐 8 语言 `locale/*.json` 与 `./locale/*.json` 导出。
6. `@deepseek-ai/dsh-session#adoptSessionEvent` 与 `sessionFormatCatalog` 登记为安全运行时导出。

## 理由

- 资源文件不暴露 API，把样式表算作域只会制造假阳性。
- 声明式 DAG 保留“未声明即失败”的约束，同时承认真实的产品组合需要单向依赖；环仍然被拒绝。
- 可选 bundle 的存在意义就是交付一个实验能力；把它挡在实验依赖之外会让 bundle patch 无法解析。
- Web 产品包是 fork 的产品面，实验能力默认开启是产品决定；名单显式可审查，而不是放宽整条规则。

## 后果

- 四个门禁转绿：`verify-client-domain-graph`、`verify-cordis-config`、`verify-locale-metadata`、`constraints`。
- 新增包必须同时提供 8 语言元数据与 `files`/`exports`；客户端包若需要共享层或域间依赖，必须写 `layers.json` 并保持无环。
- `verify-package-dependencies` 仍报告 fork 包既有的 `@reachforstar/*` 范围与 peer 声明问题，本次未处理。
