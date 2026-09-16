---
description: "用 Pi coding-agent 运行时驱动 dsh 会话：Pi 拥有回合循环，dsh 拥有会话日志、工具与持久化。"
kind: "package-reference"
---

# @deepseek-ai/dsh-pi-agent-loop

[English](README.md) | 中文

## 概述

本包用于运行以 Pi coding-agent 运行时（而非默认 dsh 循环）作为回合循环的 dsh agent（智能体）。挂载它即可在 `dsh` 会话之外提供 `backend: 'pi'` 会话：会话保留 dsh 的持久日志、头部元数据与工具策略，而由 Pi 打开模型会话、流式输出助手内容并调用工具。当部署希望借助 Pi 的提供方广度（包括通过配置注册的 OpenAI 兼容网关）并沿用 harness 的会话与持久化模型时选择本包。两个循环是并列关系而非叠加关系：同一个会话只由其中一个驱动，其 backend 记录在会话头部。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将插件挂载在默认循环旁；它以 `pi` agent factory 的身份注册自身。

### 何时选择

部署已经统一使用 Pi 运行时访问模型，或需要在 dsh 会话中使用仅 Pi 可用的提供方路线时选择本包。会话需要 dsh 循环自身的扩展点时（例如通过 agent inbox 实时引导）应优先使用默认 dsh 循环；部署无法安装 `pi` 运行时同理。两个循环可共存于同一进程，因此选择发生在会话粒度而非部署粒度。

### 最小配置

```yaml
- id: pi-agent-loop
  name: '@deepseek-ai/dsh-pi-agent-loop'
  config:
    model:
      provider: amax
      modelId: qwen-3.8-27B
    providers:
      - id: amax
        baseUrl: https://ai.amaxsmp.com/v1
        apiKeyEnv: AMAX_API_KEY
        models:
          - id: qwen-3.8-27B
            name: Qwen 3.8 27B
            contextWindow: 262000
            maxTokens: 32000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `model` | 事实上必填 | 每个会话使用的 Pi 路线，由 `provider` 与 `modelId` 组成；它优先于 dsh 的 `agentOptions.provider`/`model`——后者命名的是 dsh 适配器而非 Pi 提供方。 |
| `providers` | `[]` | 在模型选择之前注册进 Pi 的 OpenAI 兼容网关，每个网关自带 `apiKeyEnv` 与模型列表。 |
| `openSession` | 真实 Pi 打开器 | 仅供测试替换会话打开器；部署中不要设置。 |

<a id="understand-the-implementation"></a>
## 理解实现

插件以 `pi` backend 注册 [`AgentFactory`](../../../docs/agent-lifecycle.zh.md)。`createAgent` 准备 dsh 会话、通过 `sessionPersistence` 存储其持久身份、打开一个 Pi 会话并发布 agent；`resume` 重新打开持久日志、为被中断的回合追加收尾事件、恢复头部 `cwd`，并据此从历史重建 Pi 后发布。会话头部记录 `backend: 'pi'`，因此后续 resume 会回到本循环。

### 会话与事件归属

会话日志由 dsh 拥有，Pi 的流被翻译为 dsh 事件：助手文本、工具调用与结果通过默认循环写入的同一批事件类型进入日志，因此投影、遥测与持久化消费方与循环无关。翻译模块（`pi-session`、`pi-event-translator`）负责该映射。

### 工具共享

工具在两个方向跨越边界。`dsh-tool-adapter` 将每个 dsh 工具暴露为 Pi 自定义工具，其 TypeBox 参数镜像 dsh 声明，而 dsh 仍在 `ToolRuntime.execute` 内部重新校验，因此工具策略管道、审批与 hook 继续生效。`pi-tool-adapter` 反向把 Pi 注册的工具（扩展与 skill）暴露给 dsh 自身的工具面。

<a id="further-exploration"></a>
## 进一步探索

- [dsh-agent](../agent/README.zh.md) — 本包实现的 agent 生命周期与 `AgentFactory` 契约。
- [会话持久化](../../../docs/subsystems/persistence.zh.md) — Pi 驱动的会话写入的持久日志。
- [dsh-tools](../tools/README.zh.md) — 两个适配器共同接入的工具运行时。
- 无密钥的翻译器与适配器 spec 可直接运行；`pi-loop.e2e.ts` 与 `pi-session.e2e.ts` 驱动真实网关，并在缺少 `AMAX_API_KEY` 时自动跳过。

<a id="model-experience"></a>
## 模型体验

### 会话开始

#### 模型看到什么

配置路线下 Pi 自身的系统提示词与工具声明，以及由 `dsh-tool-adapter` 适配为 Pi 自定义工具的 dsh 工具。Pi 驱动的会话不运行 dsh 的 `ctx.systemPrompt` 组装。

#### Token 影响

提示词携带适配后的 dsh 工具声明，而非 dsh 自身的渲染结果；两者在参数契约上等价，但并非逐字节相同。

#### KV Cache 影响

与 dsh 循环的缓存无关：复用只取决于 Pi 的提供方、模型、指令与工具。

### 工具调用

#### 模型看到什么

经 `ctx.tools` 执行管道运行后，Pi 对其渲染的工具结果。

#### Token 影响

与默认循环一致：结果就是 dsh 管道产出的同一份规范 JSON。

#### KV Cache 影响

追加式：新的工具结果接在承载该次调用的请求可复用前缀之后。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **回合循环归 Pi 所有** —— 对 Pi 驱动的会话而言 dsh 的 agent inbox 是空转的：排队或引导的消息不会被注入正在运行的 Pi 回合，且本 backend 不发出 `agent/session-start`——Pi 已用 `agent/created` 取代它。
- **实时工具行为不保证对齐** —— 适配后的工具保留参数契约并在 dsh 内重新校验，但 Pi 侧没有 dsh 对应物的工具特性（例如 Pi 专有的流式更新）会被丢弃，而不会用近似方案替代。
- **模型路线需要显式声明** —— Pi 运行时只解析本配置注册的提供方及其自身环境配置；仅由 dsh 适配器命名的路线不会到达 Pi。
- **resume 依赖持久化** —— 缺少 `sessionPersistence` 服务时，恢复 Pi 驱动的会话会直接报错。
- **证据基线绑定单一 Pi 版本** —— 适配器 spec 与带凭据的端到端场景是针对固定版本的 `@earendil-works/pi-coding-agent` 记录的；升级该依赖需要重新验证翻译器、两个适配器与端到端场景。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作上下文——点击展开</summary>

无密钥 spec 覆盖事件翻译器与两个工具适配器；`pi-loop.e2e.ts` 与 `pi-session.e2e.ts` 驱动真实网关，并在缺少 `AMAX_API_KEY` 时自动跳过。

</details>
