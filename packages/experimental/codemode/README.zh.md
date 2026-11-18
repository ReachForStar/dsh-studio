---
description: "只能调用注入工具的沙箱 JavaScript 执行包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-codemode

[English](README.md) | 中文

## 概述

使用 `@deepseek-ai/dsh-codemode` 让模型编写 JavaScript 脚本，调用会话的工具与非 LLM 模型。脚本在 Node `vm` 沙箱中运行，没有文件系统、网络与定时器；唯一出口是 `tools` 与 `models`。只有脚本输出到达模型，因此脚本可以并行调用并先过滤大结果。适用于让模型批量处理工具工作，而不是一轮一次调用。

## 目录

- [使用方法](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用方法

在提供工具与 LLM 服务的组合中挂载本插件。它注册一个模型工具 `run_code`。

```yaml
- name: '@deepseek-ai/dsh-codemode'
  config:
    timeoutMs: 30000
    maxOutputChars: 16000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `30000` | 同步脚本执行的截止时间 |
| `maxOutputChars` | `16000` | 输出上限；更长输出保留首尾 |

### 脚本全局

| 全局 | 用途 |
|---|---|
| `tools.<名称>(参数)` | 调用可见工具；非合法标识符的名字用 `_` |
| `text(值)` | 添加一个输出项 |
| `return 值` | 把返回值作为输出 |
| `store(键, 值)` / `load(键)` | 跨调用保存 JSON 值 |
| `models.classify(请求)` / `models.generateImages(请求)` | 经 LLM 服务运行非 LLM 模型 |
| `exit()` | 成功结束脚本 |

脚本作为 async 函数体运行，因此顶层 `await` 与 `return` 可用。失败的脚本保留部分输出并报告错误。

<a id="understand-the-implementation"></a>
## 实现说明

服务每次运行构造一个 `node:vm` 上下文。它枚举代理可见的工具，并把每个名字绑定到经 `ctx.tools.execute` 派发的宿主函数，因此工具策略、审批与日志不变。非 LLM 模型经 `ctx.llm.classify` / `generateImages` 路由。脚本以 async 包装运行，允许顶层 `await`，输出经 `text` 与返回值收集。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-tools`](../../core/tools/README.zh.md) —— 工具注册表与执行，注入调用统一走它。
- [`dsh-llm`](../../llm/llm/README.zh.md) —— 非聊天模型方法。

<a id="model-experience"></a>
## 模型体验

### codemode 脚本

#### 模型看到什么

只有脚本自身的输出。沙箱全局、脚本源码与每个中间值都留在工具结果内；模型不会经 `tools` 看到其他工具的 schema。

#### Token 影响

一个工具结果替换了整个脚本的中间流量，因此并行调用与大工具输出在进对话前被过滤。脚本源码是一个工具调用参数。

#### KV 缓存影响

该工具调用是普通工具回合；请求前缀在工具结果追加前不变。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- `timeoutMs` 只约束同步执行；等待慢工具的脚本受该工具自身信号约束。
- `store` 是进程内存，按字符串键，不持久化到会话日志或投影。
- 沙箱暴露 `console`，但 `console` 输出不被收集。
- 不支持嵌套 `run_code` 调用。

<a id="dev-note"></a>
### 开发备注

沙箱刻意每次运行从实时注册表绑定工具名，因此作用域或限制变化对下一个脚本生效，无需重启进程。
