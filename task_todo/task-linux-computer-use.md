# Linux computer use（方案 A 落地，2026-11-24）

- [x] 里程碑：`cua-bundle` 的 `cordis.patch.yml` 增加 `cua-native`（仅 Linux 启用原生 Cua Driver SDK provider）
- [x] `package.json`：`dsh.bundle.platforms` 加 `linux`，`optionalDependencies` 声明 native provider，补 e2e 需要的 devDependencies
- [x] `ui-cua` 在 Linux 维持禁用并把注释改成真实原因（权限页依赖 `cuaAccess`）
- [x] `tests/platform.spec.ts` 与 `scripts/optional-bundles.spec.ts` 同步三平台断言
- [x] 新增 opt-in e2e `tests/native-linux.e2e.ts`，用真实 patch + 真实 SDK 断言 provider 与工具集
- [x] 里程碑：e2e 实跑通过；`verify-cordis-config`、`verify-runtime-closure`、`verify-default-product-isolation`、`constraints`、`verify-package-dependencies`、`test:docs`、`typecheck` 全绿
- [x] README（中英）与 i18n 记录更新：Linux 用法、X11 要求、无权限页、同进程风险
- [x] 沉淀到 `docs/wiki/queries/linux-computer-use-options.md`，更新 `index.md` 与 `log.md`
- [ ] 阻塞：Linux 的权限页与 `cua`／`cua_run_code` 绑定需要一份 Linux 原生通道（`cuaAccess` 服务），属独立能力，需先定产品形态后再做