# Agent Note: 接线 ui-polish 的 crypto-shim，修复浏览器端插件加载失败

Status: implemented

English | [中文](2026-08-22-ui-polish-crypto-shim-wiring.zh.md)

## Problem

`dsh-client-ui-polish` 的 client bundle 内联了 Excalidraw，其依赖树中的 nanoid（3.x CJS 与 4.x node 版）与 uuid@14 node 版在模块顶层引用 `crypto`/`node:crypto` 与全局 `Buffer`。browser 平台构建将 node builtin 保留为 external require，而 client module table 没有 crypto 词条，插件加载即抛 `client-modules: require("crypto") missed the module table`，`dsh web` 前端整批插件加载失败。

## Decision

`clientBundle` 共享 preset 新增 `clientPlugins` 注入点（追加到 client 构建的 plugins 数组，供包级自定义构建插件如 node builtin shim 使用）。ui-polish 在自身 `tsdown.config.ts` 中用 `resolveId` 把 `crypto` 与 `node:crypto` 解析为 `src/client/crypto-shim.ts`——该 shim 提供 named + default 导出（`randomFillSync`/`randomBytes`/`randomUUID`/`createHash` 等，用 Web Crypto 与纯 JS MD5/SHA-1 实现），顶层副作用兜底 `globalThis.Buffer`。内联后 shim 随工厂执行，require 不再落在模块表上。

构建产物验证：`lib/client.js` 中 `require("crypto")`/`require("node:crypto")` 计数为 0。运行时验证：浏览器加载 15 秒无 console/page 错误，页面出现 6 个 `style[data-plugin="@deepseek-ai/dsh-client-ui-polish"]` 标签（materialize 成功）。

## Alternatives considered

**把 crypto 加进平台 seed 表。** 拒绝——seed 表是 shell 共享的唯一词条集，crypto 是 ui-polish 私有需求，不应污染平台表。

**在 ui-polish 的 `tsdown.config.ts` 内自行拼装完整 client 配置。** 拒绝——会复制共享 preset 的大量逻辑，且后续 preset 演进难以同步。

## Consequences

- 其他 client 包不受影响（`clientPlugins` 默认空，resolveId 只匹配 `crypto`/`node:crypto`）。
- 未来接入依赖 node builtin 的浏览器 bundle 时，应复用该注入点并在包内提供对应 shim。
