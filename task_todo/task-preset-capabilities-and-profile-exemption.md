# 默认预设补挂吸收能力 + 桌面 profile 版本豁免

## 里程碑

- [x] 默认预设（`standard`）补挂 qwen-code 四项能力：`tool-search`、`memory-notes`、`tool-summary`、`followup`（提交 `6c40cc6fcb`）
- [x] 默认预设补挂星域预设的非星域能力行：`tool-ssh`（启用）、`tool-subagent-codex`、`tool-subagent-claude-code`（默认停用）（提交 `04e2b18f53`）
- [x] 星域专属行（`xingchen`/`xingchen-router`/`skill-xingchen`/`command-xingchen-clear`）保留在星域预设，不进默认预设
- [x] 用例 `packages/bundle/web-app/tests/preset-capabilities.spec.ts`：两个预设的能力行、默认预设补挂项、星域专属行缺席、provider 席位默认停用
- [x] 桌面 profile 依赖升级：`@deepseek-ai/dsh-subagent-claude-code` `0.2.1-rc.3` → `0.2.2-rc.3`（npm 最新），重装 profile
- [x] 精确版本豁免：`~/.dsh/profiles/desktop/compatibility.json` 写入 `0.2.2-rc.3` 对运行时 `0.2.2-rc.4`
- [x] 验证：profile 合成不再跳过该 bundle；`packages/bundle/web-app` 89 项、`verify-cordis-config`、`typecheck`、`lint`、`test:docs` 通过
- [x] wiki 同步（`queries/qwen-code-handoff.md`、`index.md`、`log.md`），提交推送
- [x] tmp 清理
## 阻塞

- [ ] 阻塞：`chore(todo): 跟踪预设补挂与 profile 豁免任务` 未能推送 —— pre-push 的 typecheck 被并行会话未跟踪的 `packages/context/handoff/` 打断（`src/index.ts` 的 `exactOptionalPropertyTypes` 报错、该包未登记进 `tsconfig.host.json`）。该包就绪并接线后即可推送。
- [ ] 阻塞：全量测试 1 项失败 `scripts/gen-tsconfig-paths.spec.ts` —— 同样由未跟踪的 `packages/context/handoff/` 引起（把该目录移开后该 spec 7 项全过）。
