---
title: Windows 侧 .git 迁到 Linux 后 Lefthook 钩子安装被拒
type: query
tags: [git, lefthook, hooks, cross-platform, troubleshooting]
created: 2026-10-14
updated: 2026-10-14
sources: []
status: active
---

# Windows 侧 .git 迁到 Linux 后 Lefthook 钩子安装被拒

## 问题

在 Linux 上执行 `node scripts/install-lefthook.mjs`（`pnpm install` 的 `postinstall` 会执行它）报错：

```
[install-lefthook] refusing to overwrite hooks directory with an invalid ownership marker: /data/d/deepseek-harness/.git/dsh-hooks
```

同一份仓库在 Windows 上安装钩子正常。

## 根因

仓库的 `.git` 目录随工作区从 Windows 复制到 Linux，两处记录仍是 Windows 绝对路径：

```
.git/config.worktree                 -> hooksPath = D:\deepseek-harness\.git\dsh-hooks
.git/dsh-hooks/.dsh-lefthook-owned   -> {"version":1,"owner":"...worktree-local lefthook hooks","hooksPath":"D:\\deepseek-harness\\.git\\dsh-hooks"}
```

这两个值在 Linux 下各自出错：

1. `D:\...` 不是 Linux 绝对路径，`parseOwnershipMarker()` 的 `isAbsolute()` 判定失败，安装脚本按「无效归属标记」拒绝。脚本只在标记里记录的旧路径与 worktree 配置里的旧路径相等时，才肯执行「检出目录迁移」的替换（判据 `ownedHooksDirectory.hooksPath === worktreePath`），所以此时直接卡死，不会自动纠正。
2. git 把该值当**相对路径**解析（`core.hooksPath` 允许相对顶层目录），落到仓库根下一个名字就是 `D:\deepseek-harness\.git\dsh-hooks` 的字面目录。实测：

```
$ git rev-parse --path-format=absolute --git-path hooks
/data/d/deepseek-harness/D:\deepseek-harness\.git\dsh-hooks
```

于是本机真正生效的钩子来自那个怪名字目录（由 Linux 侧 lefthook 生成，引用 `lefthook-linux-x64`），而 `.git/dsh-hooks` 里的钩子还是 Windows 版本（引用 `lefthook-windows-x64`）。

## 解法

就地按 Linux 路径修复，三步：

```bash
git config --worktree core.hooksPath /data/d/deepseek-harness/.git/dsh-hooks
printf '%s\n' '{"version":1,"owner":"deepseek-harness worktree-local lefthook hooks","hooksPath":"/data/d/deepseek-harness/.git/dsh-hooks"}' > .git/dsh-hooks/.dsh-lefthook-owned
rm 'D:\deepseek-harness\.git\dsh-hooks/pre-commit' 'D:\deepseek-harness\.git\dsh-hooks/pre-merge-commit' 'D:\deepseek-harness\.git\dsh-hooks/pre-push'
rmdir 'D:\deepseek-harness\.git\dsh-hooks'
```

改完重跑 `node scripts/install-lefthook.mjs`，它用 `lefthook-linux-x64` 重新生成 `.git/dsh-hooks` 下的钩子并回写标记（标记里 `hooksPath` 变成同一条 Linux 路径）。删除的目录里只有 lefthook 生成物，修复后不会再生成，因为解析出来的钩子目录已经回到 `.git/dsh-hooks`。

两个值的写入顺序要求：标记里的路径必须先于 worktree 配置变成当前平台可用的绝对路径，否则脚本仍在第 1 步拒绝。

## 验证

- `node scripts/install-lefthook.mjs` 退出码 0，输出 `sync hooks: ✔️(pre-commit, pre-merge-commit, pre-push)`；连跑两次结果一致（幂等）。
- `git config --show-scope --show-origin --get core.hooksPath` → `worktree file:.git/config.worktree /data/d/deepseek-harness/.git/dsh-hooks`；`git rev-parse --path-format=absolute --git-path hooks` → `/data/d/deepseek-harness/.git/dsh-hooks`。
- 直接执行 `./.git/dsh-hooks/pre-commit`，lefthook 2.1.15 正常列出各 job 并退出 0，`git status --short` 前后无变化。
- `.git/dsh-lefthook-install.lock` 无残留；`git status --short` 不再出现 `D:\...` 路径。

## 涉及模块

- `scripts/install-lefthook.mjs` — 归属标记校验（`parseOwnershipMarker`、`inspectOwnedHooksDirectory`）与迁移替换（`worktreePathIsRelocated`）。
- `.git/config.worktree` 与 `.git/dsh-hooks/.dsh-lefthook-owned` — 承载绝对路径的两个本地记录点，不进版本库。
- [worktree 本地 Lefthook 钩子设计](../../../.agents/notes/implemented/process/2026-07-27-worktree-local-lefthook.md) — 标记用途与「只替换确切的陈旧自有值」这条约定的出处。

## 复发预防

- 把带 `.git` 的工作区从 Windows 复制到 Linux（或反向）后，先别跑安装脚本。用 `git config --show-scope --get core.hooksPath` 和 `git rev-parse --path-format=absolute --git-path hooks` 各查一次：两者不一致，或后者指向仓库根下的怪名字目录，就是本次这种情况。
- 复制时排除 `.git/config.worktree`，让目标平台重新安装钩子，可以完全避开该问题。
- 两台机器共用同一份 `.git`（例如同一目录被双系统挂载）时本方案不适用：两边会互相覆盖 `core.hooksPath`。该场景需要改安装脚本，让标记校验接受另一种平台的绝对路径写法，而不是就地修值。
- 相关：[本机（Windows）合并与门禁踩坑](windows-merge-gates.md)。
