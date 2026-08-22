# Pi 与 DeepSeek Harness 双向协同

[English](README.md) | 中文

本示例把两个编码 Agent 接起来，使彼此都能向对方委托工作。

| 方向 | 机制 | 位置 |
|---|---|---|
| dsh → Pi | `pi` 子代理提供方启动 `pi --mode rpc` 并委托一个任务 | [`@deepseek-ai/dsh-subagent-pi`](../../packages/subagent/subagent-pi/README.zh.md) |
| Pi → dsh | Pi Agent Skill 运行 `dsh-delegate.mjs`，它启动一个 dsh JSON-RPC Agent 运行时并返回最终答案 | `skills/dsh/SKILL.md` + `bin/dsh-delegate.mjs` |

## dsh 委托给 Pi

组合可选提供方并暴露 `subagent_pi` 工具（具体配置行见提供方 README）。随后 dsh Agent 以自包含任务调用该工具；Pi 在父会话的工作目录中运行，只返回最终答案。

## Pi 委托给 dsh

把 Agent Skill 装进 Pi 的技能目录（`.pi/skills/dsh/SKILL.md`），把 `bin/dsh-delegate.mjs` 复制到其旁边（或把 `dsh-jsonrpc-agent` 放入 `PATH`），并提供子运行时的 `cordis.yml`。仓库参考子组合是 [`../jsonrpc-agent/cordis.yml`](../jsonrpc-agent/cordis.yml)——一个通过 stdio JSON-RPC 通信的完整无人值守 dsh 运行时。随后 Pi 运行：

```sh
node dsh-delegate.mjs <path/to/cordis.yml> "<self-contained task>"
```

辅助脚本把子 Agent 的最终答案打印到 stdout 并关闭运行时。Skill 文档说明了各覆盖项（`DSH_DELEGATE_COMMAND`、`DSH_DELEGATE_ARGS`、`DSH_DELEGATE_CWD`、`DSH_DELEGATE_PROVIDER`、`DSH_DELEGATE_MODEL`）。

## Keyless 验证

`tests/delegation.e2e.ts` 让委托辅助脚本对着脚本化子运行时（`child.cordis.yml`，其模型回显进程 cwd）运行并断言精确答案，从而端到端证明 Skill 文档描述的流程无需 API key 即可成立。dsh → Pi 方向由提供方自己的 loader 组合、keyless 真产品与带凭据 e2e 套件验证。
