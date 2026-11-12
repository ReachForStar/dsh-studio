---
description: "把 OpenAPI 3.x 操作转成模型可见工具，认证保留在主机侧。"
kind: "package-reference"
---

# @deepseek-ai/dsh-openapi-tools

[English](README.md) | 中文

## 概述

把一份 OpenAPI 3.x 文档变成模型可直接调用的工具。激活时插件读取本地文件或 URL，把每个可表达的 operation 转成 `ctx.tools` 上的工具，将 path、query、header 参数与 JSON 请求体合并进一个 schema，并通过 `fetch` 执行调用。认证留在主机侧：文档的安全声明不会进入模型，每次请求只附带一个配置的凭据。值 schema DSL 无法表达的 operation 会被跳过并记录原因，不会生成残缺的工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

每个插件实例挂载一份文档：

```yaml
- id: openapi-tools
  name: '@deepseek-ai/dsh-openapi-tools'
  config:
    spec: ./openapi/petstore.yaml
    baseUrl: https://api.example.com/v1
    headers:
      x-client: dsh
    auth:
      credential: ${credential:PET_API_TOKEN}
      scheme: bearer
```

`spec` 是本地路径或绝对 HTTP(S) URL；文档读不到、解析失败或不是 OpenAPI 3.x 时，激活以 `OPENAPI_SPEC_LOAD` 或 `OPENAPI_SPEC_INVALID` 失败。`baseUrl` 覆盖文档里的所有 `servers`；不配置时使用 operation、path item 或文档中第一个绝对 server URL。

`headers` 随每次请求发送。`auth.credential` 接受经 `ctx.credentials` 解析的 `${credential:NAME}` 引用，或直接写环境变量名；`scheme` 取 `bearer`（默认）、`header` 或 `query`，后两者必须给出 `name`。每次请求都会重新读取凭据，轮换后的值无需重启插件即可生效。凭据不可用时不发送匿名请求，而是直接失败。

限制默认值为 `timeoutMs: 30000`、`maxResponseChars: 20000`、`maxErrorBodyChars: 1000`、`descriptionMaxLength: 1024`，每项都必须是正整数。

### 命名与跳过

- 工具名取自 `operationId`，规整为 `[A-Za-z0-9_-]` 并截断到 64 个字符；缺少 `operationId` 时生成 `deletePetsByPetId` 这类名称。
- 重名工具追加稳定的数字后缀（`listPets_2`）。
- path、query、header 与请求体中同名参数按位置加前缀（`query_value`、`header_value`）。
- 每个被跳过的 operation 都通过 `ctx.logger.warn` 记录方法、路径与原因；`webhooks` 条目同样记录。

<a id="understand-the-implementation"></a>
## 理解实现

`src/document.ts` 提供文档判断与本地 `$ref` 解析。`src/schema.ts` 把 OpenAPI schema 节点转换成 `dsh-tools` 的值 schema DSL，遇到 `allOf`、`anyOf`、`not`、外部引用、元组与非 JSON 构造时抛出 `UnsupportedSchemaError`。`src/spec.ts` 加载文档并规划每个 operation：名称、描述、合并后的参数、序列化方式、请求体媒体类型与跳过原因。`src/runtime.ts` 拼 URL、序列化每个参数、附加静态头与主机凭据，并归一化响应。

支持的请求构造：

| 构造 | 支持情况 |
| --- | --- |
| `path`、`query`、`header` 参数 | path 与 header 用 `simple`；query 用 `form` 与 `deepObject` |
| 必填参数 | path 参数始终必填 |
| JSON 请求体 | `application/json` 与 `*+json`，对应一个 `body` 参数 |
| schema 关键字 | `type`、`items`、`properties`、`required`、`additionalProperties`（作为开放/封闭开关）、`enum`、`const`、`nullable`、`readOnly` 过滤、本地 `$ref` |
| 组合 | `oneOf`；递归的本地 `$ref` 降级为原始 JSON |

接受但忽略：`description`、`summary`、`format`、`default`、`example`、`deprecated` 与 OpenAPI 安全声明。不支持的请求构造会跳过整个 operation：`cookie` 参数、`allowReserved`、`spaceDelimited`/`pipeDelimited` 风格、`multipart/form-data`、`application/x-www-form-urlencoded`、任何非 JSON 请求体、`allOf`/`anyOf`/`not`、外部 `$ref`、元组 `items`/`prefixItems`、声明 `callbacks` 的 operation，以及文档级 `webhooks`。

执行时，响应内容类型为 `application/json` 或 `*+json` 时按 JSON 解析；解析失败以 `OPENAPI_RESPONSE_INVALID` 失败。其他内容类型最多返回 `maxResponseChars` 个字符。非 2xx 状态以 `OPENAPI_HTTP_ERROR` 失败，消息包含状态码与最多 `maxErrorBodyChars` 个字符的响应体。传输失败以 `OPENAPI_REQUEST_FAILED` 失败；调用方取消保持为中止。

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-tools`](../../core/tools/README.zh.md) — 工具定义、参数 schema DSL 与注册。
- [`dsh-credentials`](../../credentials/credentials/README.zh.md) — 本插件解析凭据所用的凭据引用接缝。
- [OpenAPI Specification 3.1](https://spec.openapis.org/oas/v3.1.0) — 上述文档构造的规范。

<a id="model-experience"></a>
## 模型体验

### 生成的 operation 工具

#### 模型看到什么

每个可表达的 operation 一个工具。名称是规整后的 `operationId` 或方法加路径的兜底名。描述先写 `METHOD /path`，再写 operation 的 `summary`（没有则用 `description`），压缩成一段并按 `descriptionMaxLength` 截断。参数 schema 包含合并后的 path、query、header 参数，以及 JSON 请求体对应的一个可选或必填 `body` 对象；参数描述与 `enum` 约束保留。schema 中不出现认证头、查询键或安全声明。

#### Token 影响

每个注册的 operation 都会在整个会话的每次请求中带上描述与参数 schema。开销随 operation 数量与每个转换后 schema 的大小增长；`descriptionMaxLength` 只限制描述。

#### KV 缓存影响

注册的工具 schema 属于请求前缀。文档、`baseUrl` 与本包配置不变时，它们逐字节保持稳定。修改文档、修改 `descriptionMaxLength`，或其他插件改名工具，都会替换该前缀，并使变更点之后无法复用缓存。

### 操作结果

#### 模型看到什么

JSON 响应以序列化 JSON 文本到达模型；非 JSON 响应作为文本返回并按 `maxResponseChars` 截断；空响应体变成 `null`。失败是一条句子：`openapi-tools: METHOD /path failed with HTTP <status>: <truncated body>`。

#### Token 影响

每次调用一条结果，渲染文本上限为 `maxResponseChars` 个字符。JSON 值整体渲染，因此较大的 JSON 响应可能超过该上限。

#### KV 缓存影响

结果追加在请求前缀之后，从不替换更早的 token；结果不会使缓存失效。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 JSON 请求体。`multipart/form-data`、`application/x-www-form-urlencoded`、二进制上传以及 CSV 或 XML 请求体会跳过整个 operation。
- `allOf`、`anyOf`、`not`、外部 `$ref` 与元组 items 会跳过 operation。递归的本地 `$ref` 以原始 JSON 暴露，而不是其声明的结构。
- 不解析 OpenAPI 安全声明。一个主机侧凭据作用于所挂载文档的所有 operation，因此不同 operation 需要不同凭据时必须拆分插件实例。
- 不支持 Cookie 认证、callbacks、webhooks、SSE 与二进制响应；`2xx` 响应 schema 不参与工具输出，输出统一声明为原始 JSON。
- 响应体会先整段读入再解析，且只对输出文本设限；超大 JSON 响应会占用内存与模型上下文。
- 参数的 `default`、`format`、`pattern` 与数值边界不会进入 schema，模型只能从描述或失败请求中得知。
- 一个插件实例只挂载一份文档。两份文档声明相同 `operationId` 时会在 `ctx.tools` 中冲突；请改名或挂到不同智能体下。

<a id="dev-note"></a>
### 开发备注

本包用于在没有为每个接口手写工具的情况下暴露既有 HTTP API。规划是对已解析文档的纯函数，因此每条跳过原因都能在没有网络时断言；运行时测试用真实本地 HTTP 服务覆盖成功、失败与非 JSON 响应。
