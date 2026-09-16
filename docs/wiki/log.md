# Wiki 操作日志

> 只追加、不修改历史。可用 `grep "^## \[" docs/wiki/log.md | tail -5` 看最近记录。前缀格式：`## [YYYY-MM-DD] <init|feat|fix|query|lint|chore> | <简述>`

## [2026-09-16] init | wiki-memory hook 自动创建知识库骨架

## [2026-09-17] feat | 合并上游 upstream/master 并沉淀知识

- 完成 upstream/master（`0d1f50007f`，merge base `d347e70390`）全量合并：80 个冲突文件按来源取舍，3400+ 文件自动跟随；`typecheck`、`build`、`test`（除本机负载抖动）与 `test:docs`（20 门禁）通过。
- fork 服务键 `ctx.ssh` → `ctx.sshSftp`（上游新增同名服务）；pi 后端适配上游 agent API；会话 v3 物理头承载 `backend`。
- 新增页面：[合并决策](decisions/2026-09-upstream-sync.md)、[pi 后端](entities/pi-backend.md)、[SSH/SFTP 接缝](concepts/ssh-sftp-seam.md)、[Windows 门禁踩坑](queries/windows-merge-gates.md)。
- `docs/wiki/` 在 `scripts/translation-pairing.manifest.json` 中排除双语配对（中文维护，无英文对侧）。
