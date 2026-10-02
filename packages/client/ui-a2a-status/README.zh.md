---
description: "Web 设置页里的 A2A 主机与 Kafka 状态，以及供其他浏览器包读取的 a2aStatus store。"
kind: "package-reference"
---

# @reachforstar/dsh-client-ui-a2a-status

[English](README.md) | 中文

## 概述

本包在 Web 设置页里显示 A2A 主机与 Kafka 状态。浏览器半读取由 [`dsh-a2a-status`](../../a2a/a2a-status/README.zh.md) 提供的 `a2a/status` Remote，把快照渲染成一个设置分区，并通过 `a2aStatus` store 让其他浏览器包读取同一份快照。Host 半不附带任何自身行为。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Host 已挂载状态网关与 Remote 装配的 Web 组合里挂载它。分区出现在设置页中，挂载时读取快照，读取失败时提供重试控件。

### 最小配置

```yaml
- id: ui-a2a-status
  name: '@reachforstar/dsh-client-ui-a2a-status'
```

插件需要 `slots`、`locale`、`remote` 三个服务以及 `remote.a2a` 命名空间。

<a id="model-experience"></a>
## 模型体验

无——本分区只渲染面向浏览器的状态快照。

#### KV Cache effect

无直接影响；该快照不进入模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 分区只报告网关的回答。它既不启动 Kafka 也不启动 a2a-host 监听器，因此「未运行」描述的是本部署，而不是分区的缺陷。
- 只挂载这个浏览器半、不挂 [`dsh-a2a-status`](../../a2a/a2a-status/README.zh.md) Host 网关时，会显示读取失败与重试控件，而不是一个空分区。

<a id="dev-note"></a>
### 开发备注

状态界面拆成两个包：[`dsh-a2a-status`](../../a2a/a2a-status/README.zh.md) 拥有 Host Remote 网关，本浏览器包拥有展示与 `ctx.a2aStatus` store。因此无浏览器半的组合仍可保留该网关，而分区文案放在客户端文案字典里，不上线格式。
