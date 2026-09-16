---
title: 本机（Windows）合并与门禁踩坑
type: query
tags: [merge, windows, pnpm, tsconfig, doc-gates, troubleshooting]
created: 2026-09-17
updated: 2026-09-17
sources: []
status: active
---

# 本机（Windows）合并与门禁踩坑

## 问题

在 Windows 上合并上游 3576 个文件后，`build`、文档门禁与若干测试出现一批「看似合并回归、实为环境或生成物」的失败。

## 根因与解法

| 现象 | 根因 | 解法 |
| --- | --- | --- |
| `build` 报 `TS2307: Cannot find module '@reachforstar/dsh-host-ssh-remotes/types'`（clean 之后必现） | fork 的 tsconfig 别名指向 `lib/types/types.d.ts`，而 `pnpm run clean` 删除了 `lib`；`packages/api/remotes` 未声明对 `packages/host/ssh-remotes` 的 project reference，`tsc -b` 不保证先构建它 | 在 `packages/api/remotes/tsconfig.host.json` 增加 `{ "path": "../../host/ssh-remotes" }`，别名维持 lib（project reference 输出）形态 |
| `src/` 下出现 `.js/.d.ts` 泄漏产物 | 曾把路径别名临时指向 `src/*.ts`，`tsc` 对非 `rootDir` 内文件就地输出 | 别名回退到 `lib`，删除 `src` 下产物；`pnpm run clean` 后再全量构建验证 |
| pdf license 测试 `tar: Cannot connect to C: resolve failed` | `pnpm pack --json` 返回**绝对**路径，Windows bsdtar 把盘符冒号当远程主机前缀 | 用 `basename(packed.filename)` 作为归档名、`dirname(...)` 作为 `cwd` |
| 大量测试 5s 超时（同一文件单独跑通过） | 本机在 7000+ 用例并发下负载饱和 | 隔离复跑分类；不视为回归（见「复发预防」） |
| `verify-md-links` 报 `.github/workflows/` 断链 | 早期批量替换把相对深度写成 8 级 | 统一修回 4 级（从 `.agents/notes/implemented/<kind>/` 出发） |
| `verify-archived-agent-notes` 报 seal 不匹配 | 归档笔记被链接替换脚本误改（归档是冻结区） | 还原为上游 blob，再 `--write` 重封 |
| `verify-translation-pairing` 报 out of sync | 生成器重写英文侧、或两侧同时改过内容 | 先补齐对侧（表体/说明同步），再 `verify-translation-pairing --write <pair>` 重录；一次 `--write` 只记录「已人工确认一致」的 pair |
| 生成器 `gen-doc-graphs` 抛 `missing service role classification: sshSftp` | `ctx.ssh` 改名后 `SERVICE_ROLES` 未同步 | 补 `key: 'sshSftp'`、`pkg: 'remote/ssh'` 分类（fork 包不在扫描 scope 内，用仓库路径作 owner 标签） |
| `verify-doc-budgets` 报 `docs/architecture.md` 超 2400 词 | fork 新增的 SSH/SFTP 路由表行把上游文件推过上限 | 行内压缩该行与 4 处冗余表述（不提高上限） |

## 复发预防

- 判断「合并回归 vs 本机抖动」：把失败文件**单独**跑一遍（`pnpm vitest run <path>`），本机负载类失败单跑即绿；仍失败才立案。
- 改动 `ctx` 服务键、生成器分类、双语配对记录后，一次跑齐：`pnpm run typecheck` → `gen-doc-graphs --check` → `pnpm run test:docs`。
- `docs/wiki/` 已在 `scripts/translation-pairing.manifest.json` 中排除；新增 wiki 页不需要英文对侧。
- Windows 上 `tar`、`pnpm pack`、`tsc -b` 的路径/产物行为与 POSIX 不同，涉及归档或别名时先在本机复现一次再改测试。
