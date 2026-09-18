---
title: CJS 客户端包共享 runtime chunk 导致 web boot 失败
type: query
tags: [web, client-modules, rolldown, ui-polish, 构建, 排查]
created: 2026-09-19
updated: 2026-09-19
sources: []
status: active
---

# CJS 客户端包共享 runtime chunk 导致 web boot 失败

## 问题

`dsh web` 启动报：

```
Failed to load plugins
@reachforstar/dsh-client-ui-polish
web boot: 1 entry did not activate
@reachforstar/dsh-client-ui-polish: import failed (see console for the import error)
```

浏览器端该 entry 的 `client.js` 工厂**首行**即抛错，导致整包无法 materialize。

## 根因

ui-polish 内嵌 Excalidraw，其依赖树含大量 CJS 依赖与动态 import（mermaid、pica、各 diagram chunk）。tsdown 以 `format: 'cjs'` 产出时，把 CJS interop 辅助函数（`__commonJSMin` 等）**提升到共享 chunk** `client.rolldown-runtime.js`，每个 chunk 的工厂 prologue 都同步 `require("./client.rolldown-runtime.js")`。

但 client 模块表（`dsh-client-modules`）的**同步 `require` 只能解析**：① 平台种子词（react 等）② 已注册/已 materialize 的模块表条目。它对**包内相对 chunk 名**（`./client.rolldown-runtime.js`）既无词条、也不会在 materialize 前自动去加载该 chunk 脚本——于是工厂首行 require miss，抛 `require(...) missed the module table`，entry 永不激活。

要点：动态 `require.async(...)` 的 chunk（`client.prod.js` 等）走的是 `importChunk` 异步加载路径，本来就能用；**只有 prologue 里的同步 require 无法被模块表回答**，而共享 runtime 恰好落在同步路径上。

## 解法

双向配合，让「同步 require 的 chunk 闭包」在 entry 的工厂 materialize 前完成注册：

1. **Host 端（`packages/client/modules/src/index.ts`）**：新增 `syncChunkClosure(clientPath)`——扫描 entry 同目录下所有 `client.*.js`，解析每个 prologue 的同步 require（`prologueRequires`），算出**传递同步闭包**（含 entry 自身 prologue 直接 require 的 chunk）。把闭包 chunk 的字节附到 `WebPluginRecord.syncChunks`，`buildCombo` 在每个携带该 entry 的 combo 里、entry 脚本之前一并内联注册。HMR `rebuilt()` 时按新 chunk 集合重算闭包。

2. **Client 端（`packages/client/modules/src/client/system.ts`）**：`makeRequire` 增加分支——`./client.<name>.js` 形式的相对 chunk 请求，用**包级 owner**（`chunkId(ownerId, fileName)`）解析到已注册工厂并递归 materialize。

`prologueRequires` 从 `packages/client/tsdown.client.ts` 上移到 `dsh-client-modules/src/client/manifest.ts`（浏览器安全、无 node 依赖），构建期 prologue 守卫与 host 闭包计算共用同一实现。

## 验证

- `packages/client/modules` 单测 134 通过：新增「combo 携带同步闭包」「重建后闭包变化」「相对 chunk 解析（含 chunk 再 require chunk）」「未注册相对 chunk 响亮报错」等用例。
- 重建 `dsh-client-modules`（host+client）后 `pnpm dsh web`：控制台无错，会话视图标签环出现 对话/轨迹/**Git/画布/SSH**；切「画布」tab，Excalidraw 渲染，其 `client.prod.js`/`client.file-open-*`/`client.roundRect.js` 等懒 chunk 全部 200 加载（证明同步闭包已注册、异步 chunk 路径正常）。
- 残留 404 与本问题无关：`/scene/current`（首次无场景文件，写入后恢复）、Excalidraw 的 `Assistant-*.woff2` 字体（回退字体，纯外观）。

## 复发预防

- 任何 client 包内嵌**带 CJS 依赖 + 动态 import** 的大库（如 Excalidraw）都会触发共享 runtime chunk；改依赖树后若 web boot 报某包 import failed，先查该包 `lib/` 是否出现 `client.rolldown-runtime.js`。
- 构建期已有 `prologueBuiltinGuard` 挡住「prologue require Node builtin」这一类；本问题是其兄弟形态（prologue require 包内 chunk），由 combo 闭包机制在运行期兜住。
- 客户端源码改动后必须重建产物：`tsc -b` 对应包 + 包内 `tsdown --env.DSH_BUILD_FACE client`（见 [fork Web 面板](../entities/fork-web-panels.md) 踩坑）。

## 涉及模块

- [fork Web 面板](../entities/fork-web-panels.md)（ui-polish 客户端包）
- `@deepseek-ai/dsh-client-modules`（模块表 host/client 两半）
- `packages/client/tsdown.client.ts`（client 包构建预设）
