# 回退 qwen-code / pi / opencode / codex（含 ZCode）落地能力

口径：回退 2026-11-11 至 11-18 期间为这四类来源落地的代码与接线；保留会话事件声明并标 `ignorable`，使旧会话仍可读；不重写历史，只用 `git revert` 追加提交。

- [x] 里程碑：逆序回退 pi 侧提交（handoff、prompt-templates、command-label、agent-virtual-model、classifier/image、git-checkpoint、codemode、input-handled、预设接线）
- [x] 里程碑：逆序回退 opencode 侧提交（opencode v2 融合、审批规则求值、btw、MCP 连接池/授权、PTC 预算、会话导入）
- [x] 里程碑：逆序回退 codex 与 ZCode 侧提交（审批三件套、钩子、压缩、记忆、按轮回滚、网络允许清单）
- [x] 里程碑：逆序回退 qwen-code 侧提交（agent-plugins、tool-search、记忆注入、step-summary、followup、speculation、arena、worktree 镜像、token-meter 分解）
- [x] 清理预设、bundle 补丁、包清单、依赖与 tsconfig 中指向已删包的引用
- [x] 保留被删能力的会话事件声明并标 `ignorable: true`，核对旧会话可读
- [x] 重新生成文档、模块图、配置目录、工具目录、持久化目录与客户端产物
- [x] 里程碑：`pnpm run typecheck` 与 `pnpm run lint` 通过
- [x] wiki 合并为四页（qwen-code、pi、opencode、codex+zcode），删除原九页，改写全部入链
- [x] 更新 `docs/wiki/index.md` 与 `docs/wiki/log.md`
- [x] 补升级指南，记录被移除的对外能力
- [x] 里程碑：`pnpm run build:check` 通过
- [ ] 阻塞：`test:coverage` 的 per-file 100% 阈值在本 fork 既有红项上不达标（66 个文件，含 a2a、remote/*、cua、xingchen、pi-agent-loop、ui-paper-reader 等），与本次回退无关；全量 63657 通过 / 1 既定期望失败 / 278 跳过
- [x] 里程碑：`pnpm run doc-sync` 通过
- [ ] 提交并推送（提交 b7c2b6cd90、49411b6b35；推送待完成）（按来源拆分为四个回退提交，另加文档与 wiki 提交）