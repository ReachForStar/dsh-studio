---
title: 客户端文案、包元数据与文档相对路由三门禁的清偿
type: query
tags: [门禁, locale, i18n, 客户端, 路由, fork]
created: 2026-10-30
updated: 2026-10-30
sources: []
status: active
---

# 客户端文案、包元数据与文档相对路由三门禁的清偿

## 问题

上游把三门的检查范围扩到 fork 自研面后，本地 `pnpm run hygiene` 多出三类红项：

- `verify-locale-metadata`：16 个 fork 包缺 `locale/en.json`（以及其余 7 个发布语言）。
- `verify-client-ui-i18n`：`CuaDriverInstall.tsx` 的 `HTTP {status}`、`Exit code {code}`、`Unknown error` 与 `ExcalidrawToolView.tsx` 的两个 `argsSummary` 返回值，都是直接写死的 UI 文案。
- `verify-client-route-resolution`：`CuaDriverInstall.tsx` 的两条 `/api/computer-use/cua-driver/*` 与 `ui-polish/SshPanel.tsx` 的 `/api/ssh/sftp/upload|download` 不是文档相对路由。

## 各门的规则（读门禁实现得到）

**包元数据（`verify-locale-metadata`）**

- 触发对象：`packages/**/locale/**/*.json` 所在的目录，加上 `collectConfigCatalog` 认定的每个带 `Config` 的包目录（`dir/locale`）。
- 必需集合是 `en` 与 `zh` 的并集：`en.json` 必读，`zh.json` 存在才读。其余 6 个发布语言（ja/es/fr/de/ru/pt）**必须包含并集的每个键、不得多键**。
- `meta.description` 若出现在 `en.json`，必须以 `.`/`!`/`?` 结尾。
- 非 `ja` 语言的 `meta.description` 不得等于 `en` 或 `zh` 的原文（含汉字判定）；占位符与字面 token（`{x}`、`/command`、`snake_case`）必须与并集一致。
- `meta.detail` 指向的 Markdown 必须真实存在。

**客户端文案（`verify-client-ui-i18n`）**

JSX 文本与一批承载文案的属性或命名（`label`、`message`、`title`、`placeholder`、`aria-*` 等，后缀匹配以 `Label`/`Message`/`Text`/`Title`/`Tooltip` 结尾的标识符）不允许出现字面量，必须经 `t` 座位或已本地化的 prop。

**文档相对路由（`verify-client-route-resolution`）**

应用自有路由（`/api/...`）在客户端源码里必须写成文档相对形式（`api/...`），否则部署在前缀路径下会指向站点根。

## 解法

### 1. 包元数据按上游约定补齐（16 包 × 8 语言）

- `en.json` 只写 `meta.title`（英文短名，即包名去掉 `@scope/dsh-` 与客户端包的 `client-`），与该仓库其它包的现状一致；英文 description 缺失时门禁不检查其标点。
- `zh.json` 与其余 6 语言写各自的标题与一句描述，描述逐语言翻译，避免与中英文原文相同。
- 每个 manifest 补 `./locale/*.json` 导出与 `files` 里的 `locale/*.json`：插件详情通过 `resolvePluginResource('<pkg>/locale/<lang>.json')` 解析，缺导出在发布后读不到。

### 2. 三处失败文案走字典

- `CuaDriverInstall.tsx`：新增 `cuaDriverHttpStatus`（`服务器返回 HTTP {status}`）、`cuaDriverExitCode`（`安装程序以退出码 {code} 结束`）、`cuaDriverUnknownError` 三键 × 8 语言；`check`/`install` 的 `useCallback` 依赖补 `t`，检测失败原因改为独立小字节点（原实现把它塞进全角括号）。
- `ExcalidrawToolView.tsx`：`argsSummary` 增加 `t` 参数，返回 `excalidraw.argsChars` / `excalidraw.argsShapes`（`ui-polish` 字典只有 zh/en 两语言，补两键即可）。

### 3. 路由改成文档相对

`api/computer-use/cua-driver/check`、`api/computer-use/cua-driver/install`、`api/ssh/sftp/upload`、`api/ssh/sftp/download`；与 `ui-plugin-manager` 其它路由常量（`api/plugin-manager/detail-file`）一致。

## 踩坑

- **描述里的 `-/X` 会被当成斜杠命令 token**：`localeTokens` 的正则以「`/` 前不是字母数字或 `/`」判定命令，德语描述里的 `Git-/LaTeX-/SSH-` 因此提取出 `/LaTeX`、`/SSH`，而中文描述没有这些 token，门禁报 `changes placeholders or literal tokens`。改写为 `Bereiche für Git, LaTeX, SSH und Canvas` 即消除。
- **`zh.json` 参与并集**：只写 `en.json` 也能过（`zh` 缺失时不读），但一旦提供 `zh.json`，它的键就进入并集，其它语言必须全部跟上。
- **重写 manifest 会吞掉空行**：`xingchen/package.json` 的依赖块里有一个空行，JSON 往返会删除它；为让 diff 只含 locale 两处，改完手动恢复。

## 验证

- `verify-locale-metadata`、`verify-client-ui-i18n`（1311 个源文件）、`verify-client-route-resolution`（1493 个源文件）三门通过。
- `pnpm run typecheck` 5 门、`pnpm run build` 10 门、`pnpm run doc-sync` 43 门通过；`ui-plugin-manager` + `ui-polish` 定向测试 485 项通过。
- `pnpm run lint` 对改动文件无报错；`constraints` 与 `verify-package-dependencies` 的剩余项与改动前同集合（`xingchen` 的 `peerDependencies` 版本写法、实验 MCP 包依赖、依赖分区），`publint` 的大量 `exports["./src/*"]` 报错仍属上游现状。

## 关联页面

- 红项归属与剩余债务：[fork 自研包的门禁红项清单](fork-gate-debt.md)
- 本轮合并背景：[合并上游（2026-10-30）](upstream-merge-2026-10-30.md)
