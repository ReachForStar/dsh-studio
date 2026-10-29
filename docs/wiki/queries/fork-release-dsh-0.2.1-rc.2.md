---
title: fork 发布 dsh 0.2.1-rc.2 的流程与门禁踩坑
type: query
tags: [release, 发布, 门禁, pack, tag]
created: 2026-10-18
updated: 2026-10-29
sources: []
status: active
---

# fork 发布 dsh 0.2.1-rc.2 的流程与门禁踩坑

## 问题

给 fork 发布 GitHub release（沿用上次 `dsh-v0.1.1-rc.2` 的做法：与上游同名的 tag 打在 fork 提交上 + npm tarball zip 资产 + 「同步基线 + 自研清单」正文），跑通 `scripts/release/` 一条链时连续撞四个门禁。

## 流程（按序）

```bash
pnpm exec tsx scripts/release/verify.ts --family dsh   # package.json 脚本不带 --family，须直调
pnpm run build:official                                 # 官方剖面，写构建记录
pnpm exec tsx scripts/release/pack.ts --family dsh --out dist/npm
git tag -f dsh-v0.2.1-rc.2 <发布提交> && 推送 tag
(cd dist/npm && zip -9 out.zip *.tgz publish-order.txt) # 资产命名沿用 dsh-<版本>-npm.tar.gz.zip
gh release create dsh-v0.2.1-rc.2 --title "…" --notes-file 正文.md 资产.zip
```

## 根因与解法

1. **家族必须同版本**：`verifyVersions` 要求 dsh 家族全部成员共享一个版本。合并上游后 fork 的 18 个自研包停在历史版本（0.1.0～0.1.7-rc.2 不等），全部改成家族版本 0.2.1-rc.2 后单提交。
2. **`workspace:^` 违反 packed manifest 校验**：`families.ts` 要求打包后的 `@deepseek-ai/dsh-*` 依赖恰等于家族版本；`workspace:^` 会展开成 `^0.2.1-rc.2` 被拒。上游包一律 `workspace:*`，fork 自研包 17 个 manifest 从 `workspace:^` 改齐。
3. **pack 要求官方剖面构建记录**：默认 `build:artifacts` 内联本地 commit 与 dirty 标记，与 `officialClientBuildEnvironment`（要求恰好 `DSH_CLIENT_BUILD_PROFILE`/`COMMIT_HASH`/`TITLE`/`VERSION` 四个公开值）不符即拒。用 `pnpm run build:official`。
4. **构建记录绑定 HEAD**：`DSH_CLIENT_COMMIT_HASH` 取自当前 HEAD，任何后续提交（如改 workspace 协议的修复提交）都会让记录里的 hash 落后。正确顺序是「所有修复提交完成 → 最终提交上 build:official → pack → tag 指向同一提交」；中途 pack 成功过也要重跑。
5. **显式版本可以修复家族不一致**：`planShared` 只在相对版本（`major`/`minor`/`patch`）时调用 `verifyVersions`——相对版本需要一个统一基准；显式版本本身就是目标，会把全部成员写到该版本。因此合并上游后出现的版本漂移（如 2026-10-29：18 个自研包停在 `0.2.1-rc.4`，其余 370 个是 `0.2.2-alpha.2`）可以直接用 `release:dsh <显式版本>` 修复，不必先手工改清单。该改动落在上游文件 `scripts/release/bump.ts`，属 fork 本地改动，下次合并上游若该文件有更新需保留；`verify.ts`、`pack.ts`、`local-bundle-registry.ts` 仍各自调用 `verifyVersions`，语义未变。
6. **位置放错的标志会报错而不是被忽略**：pnpm 转发参数时插入 `--`，而 `node:util` 的 `parseArgs` 在 `--` 处终止选项解析，因此 `pnpm run release:dsh -- 0.2.2-alpha.2 --dry-run` 会把 `--dry-run` 送成第二个位置参数。以前它被静默丢弃（“干跑”会真的写清单并提交）；现在 `sharedVersionRequest` 报 `release:dsh takes one version, got extra --dry-run`，并在消息里给出正确写法 `pnpm run release:dsh --dry-run -- <版本>`。

本轮验证：单元测试 42 项通过（其中 3 项属新增）、`typecheck` 5 门通过、oxlint 对两个改动文件无发现；实跑三种情形与预期一致（正确写法的干跑输出 `release bump: dry run, nothing written`；错位标志报错且不产生提交；把 `packages/xingchen/xingchen` 退回 `0.2.1-rc.4` 后，显式版本列出该包 `-> 0.2.2-alpha.2` 且不报错，相对版本仍报 `must share one version`）。

## 附带清理

`dist/npm/` 曾在 fork 早期提交里带入 231 个 0.1.1 时代 tarball。上游已不跟踪 `dist`（`.gitignore` 含 `/dist/`），且 `release:pack` 每次清空重建输出目录，故取消跟踪（`git rm -r --cached`），连同协议修复一起提交。

## 涉及模块

- [pi 后端](../entities/pi-backend.md)、[A2A 栈](../entities/a2a-stack.md)、[星域多智能体协作](../entities/xingchen-multi-agent.md)、[远端工作区 provider](../entities/remote-workspace-providers.md)（自研包清单与版本对齐范围）
- [合并上游（2026-10-18）](upstream-merge-2026-10-18.md)（发布基线的来源）

## 复发预防

- 发布前先跑 `verify --family dsh`：版本不齐与依赖协议违规都会在 pack 写盘前暴露。
- tag 指向的提交必须与最近一次 `build:official` 的 HEAD 一致；若 tag 后还有提交，重走 build + pack。
- 远端同名 tag 需要改指向时，`git push me :refs/tags/<tag>` 删除后重推，避免强推。
- 上游新 release 合并进来后，本地同名 tag 会被 fetch 更新为指向上游提交；fork 发布时必须 `-f` 移回 fork 提交（本地移动不违反强推禁令，远端更新走删除+新建）。
