# 发布 fork 新版本（版本对齐上游最新后取 0.2.2-rc.4）

## 里程碑

- [x] 里程碑：`scripts/release/verify.ts --family dsh` 通过（416 个成员统一版本、发布顺序可解析）
  - 沿 `0.2.2-rc.3` 首次尝试后改判：该号已被上游占用，发布改用 `0.2.2-rc.4`。
- [x] 里程碑：`pnpm run build:official` + `scripts/release/pack.ts --family dsh --out dist/npm` 成功，产出 tarball zip
  - 416 个 tarball；`zip -9` 成 `dsh-0.2.2-rc.4-npm.tar.gz.zip`（65MB）。
- [x] 里程碑：`dsh-v0.2.2-rc.4` 标签指向发布提交，`gh release create` 创建 Release 并附 npm zip
  - 仓库 Latest，非 prerelease；发布提交即 `release(dsh): 0.2.2-rc.4`。
- [x] 里程碑：桌面工作流触发、安装包与校验和附上（`gh release view` 核对资产）
  - macOS arm64 dmg、Windows x64 exe、`SHA256SUMS-<target>`、`nightly.yml` 已附；macOS x64 首次冒烟超时，已按 `workflow_dispatch` 重跑。
- [ ] 阻塞：Linux x64 桌面包无法在公共 runner 产出 —— 运行时要求 `@deepseek-ai/libreoffice-kit-linux-x64-glibc@0.1.1` 引擎，该包 npm 404、`pnpm-workspace.yaml` 的 `onlyPlatformBuilds` 不含它，上游在自托管 Linux runner 上构建。需要自托管 runner 预装引擎或补发布该引擎包后再跑 `workflow_dispatch`。
- [x] 里程碑：wiki 记录发布流程与新版本，`index.md`/`log.md` 同步，提交推送
  - 新增 `queries/release-dsh-0.2.2-rc.4.md`，合并页与发布流程页补关联。
- [x] 里程碑：本轮 `tmp/` 新增条目清理
