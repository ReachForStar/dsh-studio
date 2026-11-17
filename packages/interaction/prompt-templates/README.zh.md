---
description: "把 Markdown 模板变成斜杠命令、展开后作为用户消息的提示模板包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-prompt-templates

[English](README.md) | 中文

## 概述

使用 `@deepseek-ai/dsh-prompt-templates` 把 Markdown 文件变成可复用的 `/` 命令。配置目录中的每个模板文件都以其文件名成为命令；执行 `/名字 参数` 会展开模板正文，并把结果作为一条用户消息经普通会话路径注入。模板命令本身不产生模型消息，因此展开文本是唯一新增的对话输入。适用于希望复用提示文本又无需编写插件的部署。

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

在提供命令注册表的组合中挂载本插件，然后列出模板目录。只有直接的 `.md` 子文件会被加载。

```yaml
- name: '@deepseek-ai/dsh-prompt-templates'
  config:
    directories:
      - /path/to/prompts
```

模板文件以 YAML frontmatter 开头，随后是正文：

```markdown
---
description: Review staged changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness, security, and error handling}.
```

文件名成为命令名，因此上面的文件是 `/review`。`description` 出现在命令发现中，`argument-hint` 出现在输入框。缺少描述或正文为空的文件会被忽略。

### 参数替换

参数遵循类 shell 引用规则：引号只在参数开头开始引用，反斜杠在前缀同一引号时保持字面含义。

| 语法 | 结果 |
|---|---|
| `$1`、`$2` … | 单个位置参数 |
| `$@` 或 `$ARGUMENTS` | 所有参数以空格连接 |
| `${1:-默认值}` | 单个参数，或默认值 |
| `${@:-默认值}` | 所有参数，或默认值 |
| `${@:N}` | 从位置 `N` 开始的参数 |
| `${@:N:L}` | 从位置 `N` 起 `L` 个参数 |

不匹配已加载模板的输入仍是普通提示文本。

<a id="understand-the-implementation"></a>
## 实现说明

加载时，插件扫描每个配置目录，解析每个 `.md` 文件的 YAML frontmatter 与正文，并为每个有效模板注册一个命令。注册已存在的名字会告警并保留较早的命令，因此模板不会静默遮蔽既有命令。

命令处理器解析调用的自由输入，展开正文，并通过代理的普通后续路径把结果作为一条用户消息追加。消息来源记录模板名，读者可区分展开提示与手写文本。命令自身的生命周期事件只记录调用与最终结果。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-commands`](../commands/README.zh.md) —— 命令注册表与执行生命周期。
- [`dsh-skill`](../../skill/skill/README.zh.md) —— 由模型按需加载的指令，另一种复用机制。

<a id="model-experience"></a>
## 模型体验

### 提示模板展开

#### 模型看到什么

展开后的模板文本，作为普通对话中的一条用户消息。模型看不到 frontmatter、模板名或命令元数据。不匹配已加载模板的输入原样到达模型。

#### Token 影响

匹配模板会用展开正文替换输入的命令行，因此请求携带展开文本而非原始 `/名字 参数` 行。不新增提示段落或工具 schema。

#### KV 缓存影响

除普通用户消息外无其他影响：展开文本与手写文本一样改变对话前缀，没有独立缓存键。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 模板在插件加载时读取；新增或修改文件需要重载或重启。
- 只发现直接的 `.md` 子文件；不支持嵌套目录与 glob 过滤。
- 不是小写命令名的模板名会被跳过并告警。
- 模板不受项目信任门控；配置目录属受信配置。

<a id="dev-note"></a>
### 开发备注

展开是展示到消息的桥：命令只为命名模板而存在，注入的消息走普通会话路径，因此模型可见输入始终可从日志重建。
