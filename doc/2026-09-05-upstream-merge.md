# 2026-09-05 合并 upstream/master 到 fork 主线

## 任务目标

把 upstream（deepseek-ai/deepseek-harness）的最新 master 合并进 fork（ReachForStar/dsh-studio）的 master，保留 fork 已有的产品能力（SSH/SFTP、AMAX 提供方、Excalidraw、ui-polish、Pi 委托后端）。

## 干了什么

接手时仓库处于一次未完成的 merge 中途：`upstream/master`（`d347e70390`）正在并入 fork 的 `master`（`70f495bc39`），大量文件已暂存，剩余 13 个未解决冲突文件。本次按下面的决策全部解决并完成合并。

### 冲突解决决策

- **采用 upstream 版**：
  - Agent Note 文档（`2026-07-10-single-file-executable-sdk-runtime-distribution.{md,zh.md}`）——upstream 的构建目标从四目标更新到五目标，fork 无自定义内容。
  - `apps/web/tests/agent-preset-authoring.e2e.ts`——fork 加的后处理函数 `withPresetRoot` 被 upstream 已在 scaffold 层内置的 `replacements` 参数取代，直接采用 upstream 写法。
- **取 upstream 后重新生成**：
  - `pnpm-lock.yaml`——手动合并不可行；以 `git checkout --theirs` 取 upstream 版，再由 `pnpm install`（由 `pnpm run gen-doc-graphs` 触发）重新解析，找回 fork 新增依赖（`@reachforstar/dsh-host-ssh-remotes`、`ssh2` 等）。
  - `docs/event-producer-consumer.{md,zh.md}`——自动生成文件；md 由 `gen-doc-graphs` 重生成，zh 手工同步 fork 的 SSH 事件行与 `ui-polish`/`ssh` 监听方差异。
  - 两个 `.i18n.yaml` 双语记录——用 `verify-translation-pairing --write` 重新记录 blob hash。
- **合并两者**（fork 与 upstream 各有有效新功能）：
  - `packages/llm/llm-pi-ai/tests/discovery.spec.ts`——保留 fork 的「名称回退为 id 并读取 `model_name`/`title`」用例，同时纳入 upstream 的 enriched `models` map、Anthropic 路径、`data` 优先三组用例。
- **补回 fork 在合并时被误丢的 src 改动**：
  - `packages/llm/llm-pi-ai/src/discovery.ts`——先前解决该文件冲突时采用了 upstream 版，丢失了 fork 的两处功能：`ListingEntry` 的 `model_name`/`title` 候选字段（label 回退链），以及 `discoverModels` 在缺 baseURL 时回退到 `catalogProvider(provider).baseUrl`（AMAX 目录端点兜底）。本次补回。
- **确认已正确合并、仅需 add**：`packages/api/remotes/package.json`、`packages/api/remotes/src/client/index.ts`、`packages/client/connection/src/rpc.ts`、`scripts/gen-third-party-notices.ts`（均已正确保留 fork 的 SSH 注册与 ssh2 许可覆写）。

### 验证结果

- `vitest run packages/llm/llm-pi-ai/tests/discovery.spec.ts`：34 个用例全通过。
- `verify-translation-pairing`：1151 对双语文档全部一致。
- pre-push 全量 `tsc -b tsconfig.client.json` typecheck 通过。
- pre-commit hooks（lint、translation pairing、archived notes、third-party notices、whitespace、vendor manifest）全部通过。

## 改了什么（相对历史）

- 新增 merge commit `60ba3fdb85`（parent：`70f495bc39` + `d347e70390`），已推送到 `fork/master`。
- fork 相对 upstream 领先 72 个提交（71 个 fork 产品提交 + 1 个 merge）。

## 已知问题与风险

- `pnpm install` 会触发原生模块编译（`fs-ext` 等），Windows 上依赖本机 MSBuild 工具链；缺失时安装会失败。
- 仓库仍残留两个 stash（`stash@{0}` ui polish 适配、`stash@{1}` 合并前 cordis.yml），未在本次处理，属用户此前临时保存。
- 全量 `test:coverage` 未在本地跑，由 CI 兜底；本次只跑了对改动面最相关的 llm-pi-ai discovery 测试。

## 复现与运行

```sh
git status            # 应干净，master 与 fork/master 同步
pnpm run gen-doc-graphs          # 重新生成文档图
pnpm exec tsx scripts/verify-translation-pairing.ts   # 校验双语一致性
pnpm exec vitest run packages/llm/llm-pi-ai/tests/discovery.spec.ts
```

## 后续演进方向

- 观察 fork 的 SSH/SFTP、AMAX 提供方是否可作为独立 PR 向上游贡献，减少后续 merge 的冲突面。
- 若持续在 Windows 上开发，可为 fork 补一个 Windows 本地 gate（避免依赖 CI 才发现平台差异）。