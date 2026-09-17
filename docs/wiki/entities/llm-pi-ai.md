---
title: llm-pi-ai（pi-ai 适配器与提供方路由）
type: entity
tags: [llm, pi-ai, provider, catalog, discovery, amax]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: active
---

# llm-pi-ai（pi-ai 适配器与提供方路由）

## 职责

把 pi-ai 的多提供方运行时接进 harness 的 LLM seam：一个插件实例持有按路由键的 `providers` 字典，路由可复用 pi-ai 已安装目录（端点、协议、模型目录作为默认值），也可完全手工声明。profile 事实按请求解析，密钥经凭据 seam 解析。

## 关键文件与接口

| 位置 | 作用 |
| --- | --- |
| `packages/llm/llm-pi-ai/src/index.ts` | 插件入口：profile 解析与记忆化、settings 接线、目录/路由注册、发现与端点读取的接线 |
| `src/config.ts` | profile schema 与 `resolveProfiles`：路由事实只构建一次（`catalogRequest`），严格/延迟校验 |
| `src/catalog.ts` | 已安装目录集成、`resolveRouteModels`（严格时拒绝不可服务模型）、漂移门禁 |
| `src/discovery.ts` | 端点询问（配置界面用）＋ `routeEndpointCatalog`/`catalogFromListing`（运行期目录物化） |
| `src/adapter.ts` | `PiAiAdapter`：按代缓存快照、端点读取、`Models` 集合构建、`modelOf` 诊断 |
| `src/provider.ts` | 受支持协议表与 `buildProvider`（目录路由复用 pi-ai 卡片） |

## 模型解析链（2026-09-17 起）

1. `resolveProfiles(raw, validation)` 为每条路由构建一次 `RouteCatalogRequest`，再调用 `resolveRouteModels`。
2. 若路由既无 `models` 列表、已安装目录也为空，且端点可读（协议属于 `openai-completions`/`openai-responses`/`anthropic-messages`，端点取配置 `baseURL` 或目录卡片 `baseUrl`），则判定为**端点服务路由**：profile 带上 `endpointCatalog`，并以 deferred 校验解析（settings 写入也因此被接受）。
3. `PiAiAdapter` 首次有操作点名该路由时读取其 `GET /models`（配置界面同一条 `discoverModels` 路径，复用存储凭据与 `headers`），经 `catalogFromListing` 物化后并入快照；同一次配置内不再重复读取。
4. 读取失败按路由保留，请求以端点自身故障（不可达、凭据被拒、`TIMEOUT`）报错；`listModels` 返回空。

此前的行为是：amax 这类无内置目录的网关必须在配置里逐条列出模型，否则运行期直接以 `INVALID_CONFIG` 报「resolves no models」。

## 上下游依赖

- 上游：`ctx.llm`（`registerAdapter`/`registerConfigurableProviders`/`registerModelDiscovery`）、`ctx.settings`、`ctx.credentials`、`ctx.attachments`、`@earendil-works/pi-ai`。
- 下游：任何经 `ctx.llm` 取模型的服务（agent loop、compaction、Web/ACP 模型选择器）。

## 待确认

- 端点服务路由的模型列表在配置不变时不会自行刷新（新增模型需改配置或重启）——是否要在模型选择器打开时主动重读，尚未定。

## 关联页面

- [pi 后端（pi-agent-loop）](pi-backend.md) —— 模型路线由该插件的路由提供。
