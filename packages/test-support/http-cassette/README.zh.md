---
description: "把真实 HTTP 流量录制为 JSON 卡带并在测试中回放，支持顺序消费与凭据脱敏；面向需要真实线上请求与响应、又不想依赖在线服务的测试作者。"
kind: "package-library"
---

# @deepseek-ai/dsh-test-support-http-cassette

[English](README.md) | 中文

## 概述

用这个包把真实 HTTP 服务调用一次，之后回放完全相同的响应。`createCassetteFetch` 返回一个处于录制、回放或自动模式的 `fetch`：匹配的请求按卡带顺序消费条目，因此重试与轮询会依次回放各自的记录。JSON 请求体按键规范化后比较，凭据请求头与查询参数不会写入文件，正文里仍像凭据的内容默认拒绝写盘，除非传入 `redact: 'scrub'`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型侧表现](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

当测试需要先走一次真实请求/响应、之后在没有该服务时继续运行，或适配器的重试与轮询行为需要按顺序回放响应，或夹具需要证明自己发送了哪个请求时，使用本包。手写的响应桩覆盖不了这些场景。

### 入口

```ts
import { createCassetteFetch } from '@deepseek-ai/dsh-test-support-http-cassette'

const recorder = createCassetteFetch({ mode: 'auto', dir: 'tests/fixtures/cassettes', name: 'provider/retry' })
const response = await recorder('https://provider.test/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'test', messages: [] }),
})
recorder.assertComplete()
```

本地首次运行会录制 `tests/fixtures/cassettes/provider/retry.json`；之后的运行以及任何设置了 `CI` 的运行都会回放它。卡带缺失、请求匹配不到未消费条目、`assertComplete` 或 `dispose` 发现剩余条目时，`replay` 都会抛错。完整字段与诊断信息见 [`src/index.ts`](src/index.ts)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 设计

录制会用当前实例的交互覆盖卡带，并经由同目录临时文件写入，因此被拒绝的写入不会留下半成品文件。回放只读取一次卡带，把 `used` 标记保存在内存中；每个请求占用第一条方法、脱敏 URL 与规范化正文都相同的未消费条目。规范化会把文本正文解析为 JSON 并递归排序对象键，因此键顺序不影响匹配。文本类媒体类型逐字记录，其余内容以 base64 保存并显式标注 `bodyEncoding`。

### 脱敏

任何内容写入卡带之前，名为 `authorization`、`cookie`、`proxy-authorization`、`set-cookie`、`x-api-key`、`x-amz-security-token` 与 `x-goog-api-key` 的请求头会被剔除，敏感查询参数值替换为 `[REDACTED]`，文本正文会扫描 `sk-`、`Bearer `、`AKIA`/`ASIA`、`gh[pousr]_`、`AIza` 与私钥头。命中时默认拒绝写盘，除非调用方传入 `redact: 'scrub'`。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `createCassetteFetch`、卡带文件编解码、顺序匹配、脱敏与完整性断言 |
| [`tests/http-cassette.spec.ts`](tests/http-cassette.spec.ts) | 真实回环 HTTP 服务用例：录制、回放、顺序消费、脱敏、CI 拒绝与二进制正文 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [测试支持包组导航](../README.zh.md) —— 同级测试工具以及本包的定位。
- [测试策略](../../../docs/testing.zh.md) —— 本卡带服务的无密钥测试层级。
- [llm-replay](../llm-replay/README.zh.md) —— 录制会话转录的无密钥模型流回放对照实现。

-----

<a id="model-experience"></a>
## 模型体验

无。该测试工具录制并回放 HTTP 流量，不构造模型请求或提示词。

#### KV Cache 影响

无；回放只在本地返回已录制的字节，绝不接触提供方。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **匹配忽略请求头与查询顺序** —— 重放请求只有在方法、脱敏 URL 或规范化正文不同时才与录制不同；仅请求头不同的两次调用共用同一条目。
- **录制会覆盖卡带** —— 录制实例从空卡带开始，因此一个场景的全部交互要在同一次运行中录完。
- **传输编码不保留** —— 响应字节在 HTTP 客户端解码后保存，`content-encoding` 与 `content-length` 保持接收时的值；之后的回放会用这些原请求头提供已解码的字节。
- **二进制请求体按 base64 匹配** —— 文本正文按 JSON 规范化，二进制正文逐字节匹配，从不按键排序。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本包只依赖 Node 内置模块，没有插件接口，也不向任何组合挂载内容。

</details>
