---
title: codex 与 ZCode 能力采纳与回退
type: query
tags: [codex, zcode, 能力对比, 回退, 持久化兼容]
created: 2026-11-13
updated: 2026-11-23
sources: []
status: active
---

# codex 与 ZCode 能力采纳与回退

## 问题

codex 与 ZCode 两轮分析合并成一份交接，2026-11-13 至 11-14 落地，2026-11-23 回退。两份原始分析重复主题较多（权限、上下文、压缩、钩子、记忆、文件编辑、多智能体），回退同样按合并后的落点执行。

## 采纳与回退清单

| 能力 | 落地落点 | 回退方式 |
| --- | --- | --- |
| 审批按动作与资源规则求值 | `packages/interaction/user-approval` | 删除规则求值 |
| 拒绝时改写参数并回传 | 审批管道与面板输入 | 删除改写路径 |
| 审批超时结果与编辑降级匹配 | `user-approval` 与 `ui-approval` | 删除超时与匹配降级 |
| 完全访问提交凭证 | `permission-presets` 的 `/full-access` | 删除命令、服务字段与文案 |
| 审批前 `PermissionRequest` 钩子 | `packages/hooks` | 删除钩子点 |
| 钩子工作区信任准入 | `packages/experimental/hooks-claude-code` 的 `trust.ts` | 删除摘要准入、命令与测试 |
| 模型请求观测钩子 | `hook-protocol` | 删除观测点 |
| 压缩窗口重置 | `packages/compaction/compaction-basic` | 删除策略 |
| 压缩连续失败暂停 | `compaction-basic` | 删除熔断 |
| 压缩钩子与摘要模型回退 | `compaction-basic` | 删除钩子与回退 |
| 记忆写入工具与召回选择 | `packages/context/memory-notes` | 删除包 |
| 按轮文件回滚 | `packages/deliverables/workspace-changes` 与 `/rewind` | 删除按轮回滚与命令 |
| 运行时上下文按节增量 | `packages/core/agent-loop` 的 runtime context | 删除分节发送 |
| Web 网络域名允许清单 | `packages/sandbox` 与 Web 宿主 | 删除允许清单 |
| `apply_patch` 默认预设启用 | `packages/bundle/web-app/presets/standard.patch.yml` | 恢复默认关闭 |

## 回退后保留的持久化兼容

`approval/full-access` 事件仍声明在 `packages/interaction/user-approval/src/retained-events.ts`；`memory-notes` 消息来源声明在 `packages/core/session/src/retained-events.ts`。二者都是 log-only 或 attribution-only 记录，保留声明后发布版录下的会话仍可读，本构建不再产生它们。

## 未落地项

动态工作流类型化与依赖调度、多会话协作消息板与代理图、外部配置与会话迁移、沙箱网络代理与完整性检查、Provider 三层配置、rollout-trace 与帧桶诊断。这些只停留在交接页，没有代码可回退。

## 复发预防

- 审批改动跨 `user-approval`、`ui-approval`、`permission-presets`、`tool-executor-ptc` 与 a2a 网关五处，回退或再引入都要一次改完并跑完这五处的测试。
- 压缩策略改动要同时覆盖后台推测、失败熔断与模型回退三条路径，单测其中一条会漏掉相互覆盖。

## 关联页面

- [回退 qwen-code 能力](qwen-code-capability.md)
- [回退 pi 能力](pi-capability.md)
- [回退 opencode 能力](opencode-capability.md)