---
title: pi 能力采纳与回退
type: query
tags: [pi, 能力对比, 回退, 持久化兼容]
created: 2026-11-17
updated: 2026-11-23
sources: []
status: active
---

# pi 能力采纳与回退

## 问题

对照本机安装的 pi 1.5.2（`earendil-works/pi`）评估可采纳能力，8 项于 2026-11-17 至 11-18 全部落地，2026-11-23 随其余来源一并回退。本页记录这段往返。

## 采纳与回退清单

| 能力 | 落地落点 | 回退方式 |
| --- | --- | --- |
| 虚拟模型路由 | `packages/core/agent-virtual-model` 与 `AgentModel.resolve()` | 删除包与解析路径 |
| 分类器与图像模型运行契约 | `packages/llm/llm` 的非 chat 运行能力 | 删除契约与文档 |
| codemode 沙箱脚本工具 | `packages/experimental/codemode` | 删除包 |
| 提示模板命令 | `packages/interaction/prompt-templates` | 删除包 |
| 输入事件三态（handled） | `packages/interaction/input-handled` | 删除包与准入判断 |
| 会话标签命令 | `packages/interaction/command-label` | 删除包与投影 |
| Git 检查点命令 | `packages/experimental/git-checkpoint` | 删除包与政策登记 |
| `/handoff` 上下文转移 | `packages/context/handoff` | 删除包 |
| 默认预设挂载六项 | `packages/bundle/web-app/presets/standard.patch.yml` | 删除挂载行 |

未包含在本轮的 pi 集成：[pi 后端](../entities/pi-backend.md) 与 [llm-pi-ai](../entities/llm-pi-ai.md) 属于模型提供方与回合循环的长期落点，仍在仓库中。

## 回退后保留的持久化兼容

`session/label`、`virtual-model/state` 与 `prompt-template`、`handoff` 两种消息来源的声明改由保留模块承担：

- `packages/core/session/src/retained-events.ts`：`session/label`、`virtual-model/state`、`prompt-template`、`handoff`。
- 保留的理由与机制见 [qwen-code 能力采纳与回退](qwen-code-capability.md) 的兼容小节。

## 未采纳项

树与分支摘要、pi-tui、pi-telemetry、pi-schema、包分发、RPC 子进程。

## 复发预防

默认预设的挂载行与 `scripts/experimental-package-policy.ts` 的产品登记必须同进同退：先撤包再撤登记，`verify-default-product-isolation` 会同时检查两边。

## 关联页面

- [回退 qwen-code 能力](qwen-code-capability.md)
- [回退 opencode 能力](opencode-capability.md)
- [回退 codex 与 ZCode 能力](codex-zcode-capability.md)