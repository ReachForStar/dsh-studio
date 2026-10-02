---
description: "选择星域路由包与它的代理预设，让一个会话拥有四个角色。"
kind: "package-group"
---

# xingchen/ — 星域角色

[English](README.md) | 中文

## 概述

本分组承载星域（星辰）角色路由：一个包把会话的工作分成四个角色——启明作为原生路由器，天权/瑶光/天梁作为 A2A 专家席位——以及组合它的预设。生成式的服务与会话投影 API 见[星域子系统页](../../docs/subsystems/xingchen.zh.md)。

## 目录

- [包](#packages)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`xingchen/`](xingchen/README.zh.md) | 在已配置的 A2A 对等端之上注册 `xingchen_route` 委派工具、`/review` `/bug` `/planning` 命令、路由提示词段落，以及 `xingchen` 角色/终止原因会话投影。 | `ctx.xingchen` |

挂载它的预设随 Web 应用组合包 [`@deepseek-ai/dsh-web-app`](../bundle/web-app/README.zh.md) 发布：随包 `standard` 预设把路由行加进默认组合，`xingchen-qiming` 是同一套组合但人设换成启明。
