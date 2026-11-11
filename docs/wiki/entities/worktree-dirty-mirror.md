---
title: worktree 脏状态镜像（mirrorUncommitted）
type: entity
tags: [worktree, git, arena 前置, 沙箱]
created: 2026-11-11
updated: 2026-11-11
sources: []
status: active
---

# worktree 脏状态镜像（mirrorUncommitted）

## 职责

`WorktreeService.create` 默认从本地提交建一个干净检出；请求带 `mirrorUncommitted: true` 时，把源检出的未提交工作一并带进新检出，供「在隔离副本里继续未提交的工作」这类场景使用（Arena 的前置能力）。

## 实现要点

| 步骤 | 做法 | 约束 |
| --- | --- | --- |
| 已跟踪改动 | 在源检出执行 `git stash create` 取快照提交，再在新检出执行 `git stash apply <sha>` | 不触碰源索引与工作区：`stash create` 只创建提交对象 |
| 未跟踪文件 | `git ls-files --others --exclude-standard -z` 列出后逐个复制 | 走 `ctx.fs.resolve`、`readBytes`、`writeBytes`，写入受调用方沙箱策略约束 |
| 单文件上限 | 配置 `mirrorMaxFileBytes`（默认 8 MiB） | 超限的未跟踪文件使创建失败，不做静默跳过 |
| 无改动时 | 快照为空字符串，未跟踪列表为空 | 新检出停留在钉住的提交上，状态干净 |

失败路径与既有创建路径一致：报错文本说明「已创建的检出与分支保留」，由调用方决定是否清理。

## 上下游

- 调用方：`packages/experimental/tool-worktree` 的 `create_worktree`，参数名同为 `mirrorUncommitted`。
- 依赖：`ctx.fs`（含 `writeBytes`）、`ctx.sandboxPolicy`、`ctx.subprocess`、`ctx.workingDirectory`。
- 结果契约不变：`CreatedWorktree` 仍是 `path`/`branch`/`baseCommit`/`repositoryRoot` 四项。

## 测试与已知限制

- 覆盖率 100%（语句 175/175）；新增三个用例：脏状态镜像、默认不镜像、干净源检出镜像后仍干净。
- 本机 `restore` 相关既有用例在 5 秒默认超时下失败，`git stash` 掉本包改动后同样失败，属本机 git 耗时；加 `--testTimeout=30000` 后全绿。
- 符号链接配置目录、submodule 与 `.gitattributes` 转换不在镜像范围内；只镜像未跟踪**文件**，未跟踪目录随其文件一起复制。

## 后续

Arena 本体的前置条件（隔离副本 + 脏状态一致）已具备，剩余工作是每个模型一个 Session、并行执行、对比与胜者 diff 应用。
