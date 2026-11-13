---
description: "Web 设置「插件」页中的 MCP 服务器标签页：经 mcpManager Remote 展示托管服务器的实时连接状态，并提供授权、清除授权与重启。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-mcp

[English](README.md) | 中文

## 概述

`dsh-client-ui-settings-mcp` 在 Web 客户端的「设置 → 插件」页中增加 MCP 服务器标签页。它列出宿主的 [`dsh-mcp-manager`](../../mcp/mcp-manager/README.zh.md) 管理的全部服务器，显示实时连接状态，并提供管理器公开的操作：为需要 OAuth 的远程服务器授权、清除已存凭据、重启实例。页面只读取一条可重连的流，状态变化无需轮询即可到达。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

Web 应用组合把本行与 `dsh-mcp-manager` 一起挂载，无需配置。打开「设置 → 插件 → MCP 服务器」。

| 操作 | 出现条件 | 作用 |
|---|---|---|
| 授权 | 条目配置了 `oauth` | 启动宿主的交互授权，并在新浏览器标签页打开返回的 URL |
| 清除授权 | 条目配置了 `oauth` | 删除已存凭据；实例重建并报告 `waiting-authorization` |
| 重启 | 服务器未停用 | 替换实例并重置重连预算 |

页面原样显示宿主状态：已连接并带工具数、连接中、重连中并带尝试次数、等待凭据或授权、失败并带原因、已停用或已关闭。失败时在该行下方显示最近诊断。页面从不修改配置；服务器条目仍由「设置 → 插件」的配置和注册它的插件负责。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器半边注册 `settings.plugins.tab`，id 为 `mcp`。`apply` 在 `mcpManager.watch(signal)` 上打开一条 `ctx.remote.$stream`，把每次列表发布给订阅者；载体失败时显示不可用横幅，同时流会自动重连。操作调用 `mcpManager.authorize`、`mcpManager.forgetAuthorization` 与 `mcpManager.restart`，解包 Remote 结果，并把宿主错误文本显示在对应行下。

组件只是一份快照加操作面的纯投影，因此无需宿主即可在测试中渲染。授权使用 `window.open(url, '_blank', 'noopener,noreferrer')`；若某次流程只存了令牌而没有重定向，则不打开任何页面。

宿主半边导出空的 `apply`，让插件在 Loader 中有对应行；浏览器半边由包清单里的 `dsh.client` 发现。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-mcp-manager`](../../mcp/mcp-manager/README.zh.md)——服务器集合、状态与页面调用的 Remote 操作。
- [`dsh-mcp-client`](../../mcp/mcp-client/README.zh.md)——单实例连接行为与 OAuth 流程。

<a id="model-experience"></a>
## 模型体验

无。本包是浏览器侧的设置投影，只读 `mcpManager` Remote，不注册任何面向模型的内容。

#### KV Cache 影响

任何模型请求都不携带本包输出，因此不影响提示前缀复用。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **只读状态，不编辑配置**——服务器条目由「设置 → 插件」与注册它的插件配置；本页不提供字段。
- **授权需要可达的回环回调**——宿主在 `127.0.0.1` 上等待重定向，远程或 SSH 宿主要先转发该端口，打开的 URL 才能完成。
- **页面依赖管理器 Remote**——从宿主组合中移除 `dsh-mcp-manager` 的部署不会挂载本标签页。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的方向。它明确不具权威性——已交付行为、限制与既定理由以上文、包代码与所链接的 Agent Note 为准。

- 服务器条目由「设置 → 插件」配置编辑，因此本页刻意保持只读；在这里放字段编辑器会重复 ConfigEditor 的契约。
- 从本页触发单服务器探测是开放方向；管理器已提供 `probe`，但本页还没有承载其阶段分类结果的位置。

</details>
