---
description: "Agent Plugins v1 加载器：把可移植 plugin.json 包里的技能与 MCP 服务器发布到 harness 的技能与 MCP 接缝。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-plugins

[English](README.md) | 中文

## 概述

加载 [Agent Plugins v1](https://agent-plugins.org/) 包，且不改写包内文件。配置好的包把 `skills/<dir>/SKILL.md` 送进 `ctx.skills`，把根目录 `mcp.json` 的条目注册到 `ctx.mcpManager`，因此同一个目录对所有理解可移植布局的工具都可用。加载器只读包文件，唯一的写入是 stdio 服务器收到的 `PLUGIN_DATA` 目录。需要采用第三方包、而不是把每项能力都做成 harness 插件时挂载它。

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

### 何时选用

用户在会话里安装可移植的 Agent Plugins 包，并期望其中的技能与 MCP 服务器出现时选用。加载 harness 插件不适用本包：那类插件是 Cordis 包，由加载器挂载。

### 挂载

```yaml
- id: agent-plugins
  name: '@deepseek-ai/dsh-agent-plugins'
  config:
    plugins:
      - /opt/agent-plugins/review-kit
    dataRoot: /var/lib/dsh/plugin-data
```

`plugins` 列出包目录，绝对路径或相对进程工作目录的路径。`dataRoot` 默认 `<dsh home>/plugin-data`；加载器在注册该包的 stdio 服务器前创建 `<dataRoot>/<包名>`。`skillRank` 默认 `300`，与自定义技能根同级，用于决定两个来源发布同名技能时谁胜出。

配置的目录必须含合法的 v1 `plugin.json`。根缺失、manifest 经符号链接逃逸、或 manifest 非法都会让插件激活失败：路径来自配置，用户要的包没拿到时加载器不会继续运行。

### 包内可含内容

| 组件 | 位置 | 发布形式 |
|---|---|---|
| 技能 | `skills/<dir>/SKILL.md` | 每个目录一个技能候选；frontmatter 的 `name` 必须与目录名一致，`description` 为 1–1024 字符 |
| MCP 服务器 | `mcp.json` → `mcpServers` | `stdio` 与 `streamable-http` 条目；`sse` 与未知传输被跳过 |

条目可使用 `${PLUGIN_ROOT}` 与 `${PLUGIN_DATA}`。stdio 条目的环境变量会收到这两个值，`cwd` 默认 `${PLUGIN_ROOT}`。同一包中某个组件非法时，其余组件照常可用。

<a id="understand-the-implementation"></a>
## 理解实现

### 包含性校验

每个组件路径经 `realpath` 解析后必须留在包根内。manifest 逃逸拒绝整个包；技能或 MCP 条目逃逸只跳过该组件。校验发生在内容进入目录或注册之前。

### 名称与冲突

注册的 MCP 服务器名为 `<包名>-<条目名>`，`[A-Za-z0-9_-]` 之外的字符替换为 `-`。超过 MCP 命名空间 32 字符上限的名称保留前 23 个字符加完整名称的 8 位哈希，不同长条目不会静默撞名。两个包产生同一服务器名时先注册者胜出，加载器打印含两个名称的警告。

<a id="further-exploration"></a>
## 延伸阅读

- [Agent Plugins v1 规范](https://agent-plugins.org/)
- [`dsh-skill`](../../skill/skill/README.zh.md) — 这些技能加入的 provider 注册表
- [`dsh-mcp-manager`](../../mcp/mcp-manager/README.zh.md) — 这些服务器注册到的管理器
- [`dsh-skill-filesystem`](../../skill/skill-filesystem/README.zh.md) — 对照用的本地技能发现

<a id="model-experience"></a>
## 模型体验

### 技能目录

#### 模型看到什么

包内技能与文件系统技能出现在同一目录：可调用名称与描述，以及按需加载的正文。加载器自身不添加文本。

#### token 影响

只占目录已列出的胜出技能；正文在模型加载时计费。

#### KV 缓存影响

追加式，经由既有技能目录与工具结果；加载器不改动请求前缀。

### MCP 工具

#### 模型看到什么

已注册服务器的工具以 `mcp__<server>-` 命名空间出现，与配置的 MCP 服务器一致。加载器不添加指令或会话事件。

#### token 影响

服务器注册期间，每个对外公布的工具把 schema 加入每次请求。

#### KV 缓存影响

注册或撤销服务器会重写工具块；稳定状态不追加内容。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 只加载两类可移植组件。Agent Plugin 的命令、智能体、钩子、上下文、设置、通道与应用一律忽略。
- 包变更需重启：加载器在激活时读取一次 manifest 与各组件。
- 旧式 `sse` 传输直接跳过，不做转换。
- 不安装、下载或对市场校验包；目录由用户提供。
- 列举技能或读取技能文件时遇到非缺失类文件系统错误，查询失败而不是降级。

<a id="dev-note"></a>
### 开发备注

包文件从不改写；加载器的唯一写入是每包的 `PLUGIN_DATA` 目录。逐文件覆盖率保持 100%，两处原生非缺失类 I/O 失败带理由的窄 `v8 ignore` 标注。
