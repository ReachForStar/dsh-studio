# Agent Note: Pi 子代理后端

Status: implemented

[English](2026-08-15-pi-subagent-backend.md) | 中文

## 问题

subagent 接缝支持向 Claude Code 与 Codex 的进程外委托，但不支持 [Pi](https://github.com/earendil-works/pi)——与本仓库通过 `dsh-llm-pi-ai` 引入的 `@earendil-works/pi-ai` 库同源的开源编码 Agent。dsh Agent 无法向 Pi 子进程委托任务，与 Pi 的双向协同缺少 dsh→Pi 这一半。

## 决策

`@deepseek-ai/dsh-subagent-pi` 在 `ctx.subagents` 上注册固定的 `pi` 提供方。每个被接受的 run 通过 subprocess 接缝在委托 Session 的工作目录中 spawn `pi --mode rpc`，用一条 `get_state` 命令证明就绪，用 `prompt` 提交一个文本任务，等待流式 `agent_settled` 事件，再用 `get_last_assistant_text` 读取终态答案——最后一条非空 assistant 文本。扩展 UI 对话框以 `cancelled` 自动应答，无人值守的 run 不会挂在本提供方并不拥有的 UI 上。销毁时关闭线、请求 Pi 协作式 EOF 关闭、等待 `disposeEofGraceMs`，再升级到共享的进程树终止阶梯。提供方不声明任何启动时能力，并报告 `inheritsParentContext: false`。

线契约钉在 `@earendil-works/pi-coding-agent@0.84.2`（RPC 命令 `get_state`、`prompt`、`get_last_assistant_text`、`abort`；响应 `{ id, type: "response", command, success, data | error }`；`agent_settled` 事件）。停止原因映射：非空答案 → `completed`；无答案结算、`prompt` 失败、协议或进程失败 → `error`；本地取消 → `aborted`。经本提供方，Pi 不产生 `max-tokens` 与 `refusal`，且取消与失败以空输出快照结算，因为 Pi 的 RPC 协议不暴露已提交的部分输出投影。

`PI_CODING_AGENT_DIR` 与 `PI_CODING_AGENT_SESSION_DIR` 作为绝对 `agentDir`/`sessionDir` 覆盖项可配置，部署可把 Pi 的 agent 与会话状态重定向出用户原生 home；模型选择保留给 Pi 原生配置，部署可通过 `args` 覆盖钉住提供方。keyless 真产品测试把钉死版本的 npm CLI 作为确定性 fixture；带凭据的 e2e 通过 pi-ai 的 `deepseek` 提供方委托一个 nonce。

这是 Pi 双向协同的 dsh→Pi 方向。Pi→dsh 方向是一个驱动 dsh JSON-RPC Agent bin（`dsh-jsonrpc-agent`）的 Pi Agent Skill，以 `pi-dsh` 示例形式发布，使两个产品能互相委托。

## 备选方案

### 用 Print 模式而非 RPC 模式

`pi -p "task"` 存在且更简单，但它没有会话就绪握手、取消动词与终态答案查询；提供方将不得不解析自由 stdout。RPC 模式把 `get_state` 就绪、`abort` 与 `get_last_assistant_text` 作为协议契约提供，并镜像 Codex app-server 后端的形态。

### 通过第三方 ACP 适配器驱动 Pi

`pi-acp` 为 Pi 增加 Agent Client Protocol 支持，可让现有 `subagent-acp` 提供方零新代码驱动 Pi。但它是第三方适配器，有自身的版本与兼容面，且无法承载本提供方拥有的就绪/答案/取消契约。固定的 `pi --mode rpc` 接口才是产品原生的嵌入面。

### 先建 `dsh-mcp-server` 再经 MCP 连接 Pi

Pi 的 MCP 客户端支持在交付时仍是未决 issue，仓库也没有 MCP 服务器能力。服务器会让每个 MCP 宿主受益，但 subagent 提供方是更小、更仓库原生的路径，今天即满足委托契约；MCP 服务器工作留作单独决策，另立 note。

## 后果

- 仅一次性：每次 run 都是全新的 Pi RPC 进程、会话文件与 turn；没有续跑、恢复、池化或进度流，与其它外部 CLI 提供方一致。
- 宿主管理的产品状态：Pi 安装、认证与模型选择保持原生；插件不提供安装器、登录流程或版本门禁，凭据必须在 subprocess 接缝擦除后经显式 `env` 叠加提供。
- 协议钉版本的负担：升级 Pi 需要重新生成线证据并重跑握手、答案、取消、keyless 真产品与带凭据 nonce 用例，与 Codex 后端的钉死基线一致。
- 除共享 subagent 工具结果契约外，提供方不贡献新的持久事件或模型可见输入，因此会话日志不变式不受影响。
