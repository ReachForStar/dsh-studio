# @deepseek-ai/dsh-subagent-pi

[English](README.md) | 中文

本包注册固定的 `pi` 子代理提供方。每个被接受的 run 都会在委托方 Session 的工作目录中启动 [Pi 编码 Agent](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`）的 RPC 模式，通过 Pi 的逐行 JSON stdio 协议提交一个自包含的文本任务，并仅通过共享的 [`dsh-subagent`](../subagent/README.md) 结果契约返回最终答案。

## 启动与所有权

`start(request)` 只接受非空文本块序列，并从父 Session 推导子进程 cwd。随后通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) 启动固定的 `pi --mode rpc` 命令，仅在 RPC 服务器应答了 `get_state` 就绪探测后发布 run。发布前的失败或取消会先关闭线、终止受管理的进程树、等待其退出，再拒绝 `start()`。

已发布的 `run.result` 恰好开启一个 turn。它发送 `prompt` 命令，等待流式 `agent_settled` 事件，再用 `get_last_assistant_text` 读取终态答案——最后一条非空 assistant 文本。Pi 的 RPC 响应不暴露已提交的中间输出投影，因此取消与失败以空输出快照结算。结算后无答案、`prompt` 响应为 `success: false`、协议失败或进程失败都映射为 `error`；本提供方不产生 `max-tokens` 与 `refusal`。

扩展 UI 对话框（`select`、`confirm`、`input`、`editor`）会被自动以 `cancelled` 应答，无人值守的 run 不会等待本提供方并不拥有的用户界面；其余扩展 UI 请求（`notify`、`setStatus` 等）被忽略。本地取消赢得结果竞态并映射为 `aborted`。`dispose()` 幂等：关闭线，通过 stdin EOF 请求 Pi 协作式关闭，在 `disposeEofGraceMs` 之后升级为共享的进程树终止，并等待整树退出。结果失败与独立的销毁失败保持分离。

## 能力与上下文

本提供方不声明任何可选启动时能力，并报告 `inheritsParentContext: false`。Pi 收到独立文本任务与父 Session cwd，但不收到父会话对话、persona、工具过滤、深度策略或结构化输出契约。每次 run 都有独立的 RPC 进程、会话文件与取消控制器。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `env` | `{}` | 显式子进程环境，叠加在 subprocess 接缝的凭据擦除父环境之上。Pi 凭据（例如 `DEEPSEEK_API_KEY`）与任何 Pi 扩展变量都应放在这里。 |
| `disposeEofGraceMs` | `6000` | 正有限毫秒宽限，不大于 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)，介于 Pi 的 stdin-EOF 关闭请求与共享进程树终止升级之间。 |
| `disposeGraceMs` | `3000` | 正有限毫秒宽限，不大于 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)，介于共享进程树所有者的终止层级之间。 |
| `command` | `pi` | Pi 可执行文件（`PATH` 上的裸名称）或测试 fixture 启动器。Windows 上 argv 会被包进 `cmd.exe /d /s /c`，因为 npm 与 pnpm 安装暴露的是 `pi.cmd`。 |
| `args` | `['--mode', 'rpc']` | 追加在可执行文件后的固定参数；该数组整体替换默认值，因此覆盖时必须重申 `--mode rpc`。部署可在此钉住 Pi 的模型，例如 `['--mode', 'rpc', '--provider', 'deepseek']`。 |
| `agentDir` | 未设置 | 绝对 `PI_CODING_AGENT_DIR` 覆盖，指定 Pi 保存 agent 设置与信任状态的位置；省略时 Pi 使用其原生 home（`~/.pi/agent`）。优先于 `env.PI_CODING_AGENT_DIR` 条目。 |
| `sessionDir` | 未设置 | 绝对 `PI_CODING_AGENT_SESSION_DIR` 覆盖，指定 Pi 保存会话文件的位置；省略时 Pi 使用其原生会话位置。优先于 `env.PI_CODING_AGENT_SESSION_DIR` 条目。 |

生产环境从 subprocess 执行世界的凭据擦除 `PATH` 解析 `pi`。原生 Pi 设置与认证保持权威：本插件不安装 Pi、不选模型、不创建 Pi home、不登录、不探测版本。凭据形态的环境变量在显式 `env` 叠加前被移除，因此给子进程的 API key 或令牌必须在这里提供。

随附 profile 在宿主机加载一次本提供方，在工具调用前不启动任何 Pi 进程。完整 Agent Preset 携带下面的工具行并带 `disabled: true`；复制 preset 并移除该字段，即可只把 `subagent_pi` 暴露给由该副本组合出的 Agent。自定义宿主组合也可直接使用两行。

```yaml
- id: subagent-pi
  name: '@deepseek-ai/dsh-subagent-pi'
  config:
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY

- id: tool-subagent-pi
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: pi
    toolName: subagent_pi
    enableRunInBackground: false
    maxDepth: provider-managed
```

## 产品兼容性与证据

运行时依赖钉在 `@earendil-works/pi-coding-agent@0.84.2`。生产环境运行原生 `pi` 安装。keyless 真产品测试把钉死版本的 npm CLI 作为确定性 fixture，走相同的原生可执行解析与 Windows 批处理 shim 路径；它不声称与每个独立安装的版本兼容。RPC 线只实现本一次性契约所需的命令（`get_state`、`prompt`、`get_last_assistant_text`、`abort`）；升级 Pi 需要重新生成协议证据并重跑握手、答案、取消与销毁用例。Loader 组合证明两个产品包共存且不启动任一产品。

## Model Experience

### 子请求

#### 模型看到什么

Pi 子进程在新会话中把独立文本任务作为一次全新 RPC prompt 接收。其工作区是父 Session cwd，而模型、系统指令、工具与认证来自原生 Pi 安装与配置（`args` 可钉住提供方）。

#### Token 影响

子进程支付独立的 Pi 上下文与 turn。子进程 token 不进入父上下文。

#### KV 缓存影响

与父请求缓存无关。复用只取决于 Pi 自身的提供方、模型、指令、工具与新会话。

### 父工具结果（间接）

#### 模型看到什么

经 `dsh-tool-subagent`，父进程只看到严格最终 Pi 答案，或非 completed 结果时消费者给出的精确错误。Pi 推理、工具活动、中间消息、stderr、工作区 diff 与产品 id 不会被复制进父 Session。

#### Token 影响

父输入只增长工具结果保留的最终答案或错误。本提供方本身不增加父工具 schema。

#### KV 缓存影响

仅追加：新工具结果跟随可复用的父请求前缀。

## 已知局限与后续工作

- **每次 run 都是全新 RPC 进程、会话与 turn** —— 没有续跑、恢复、池化、进度流或产品会话持久化。
- **宿主管理的产品安装与账号状态** —— 缺失或不兼容的 `pi`、配置错误或认证失败以启动期或运行期错误呈现；插件不提供安装器、登录流程或运行时版本门禁。
- **模型选择保留给宿主 Pi 配置** —— 默认 `args` 不选择提供方；需要时部署通过 `args` 钉住 `--provider`/`--model`。
- **兼容性由开发证据钉死** —— 从已验证的 0.84.2 协议基线升级需要重新生成上游 schema 证据并重跑握手、答案选择、取消、keyless 真产品与带凭据的 DeepSeek nonce 用例。
- **无人工交互路径** —— 扩展 UI 对话框被自动取消，其他交互流程缺失，需要新审批或输入的任务会失败而不是挂起。
- **仅最终文本** —— 推理、中间消息、工具流量、用量、stderr 与工作区 diff 保持产品本地；取消与失败不带部分输出，因为 Pi RPC 协议不暴露已提交的部分投影。
- **无可选共享能力** —— 输出 schema、子 persona、工具过滤与 harness 深度强制会被共享服务对本提供方拒绝。
- **无墙钟超时或副作用回滚** —— 调用方取消长任务，取消前被改动的文件或外部系统不会恢复。
