# 补充修复：门禁红项与覆盖率豁免（2026-11-24）

## 门禁红项

- [x] 清 11 个只剩 `lib`/`node_modules` 的残渣目录，`constraints` 的目录报错消失
- [x] webhook 归属定案并实施：登记进 `EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS` 与 `DEFAULT_PRODUCT_EXPERIMENTAL_PACKAGES`（默认组合的投递原语）；`constraints` 与 `verify-default-product-isolation` 的 webhook 项转绿
- [x] `verify-default-product-isolation` 的 `tool-ralph` 项处理（登记为可选 bundle `ralph-bundle` 的唯一工具）
- [x] `verify-product-use`：为 `pi-agent-loop`、`fs-sftp`、`subprocess-sftp`、`subagent-pi` 登记 optional 维护角色
- [x] `verify-package-dependencies`：删除 2 条未使用的 safe-host 导出登记
- [ ] 阻塞：`verify-no-unknown-casts` 的 156 处断言需逐点重写夹具（含 `ui-polish`、`ui-paper-reader`、`a2a` 的 DOM/服务桩与产品源码）；ADR `2026-09-19-no-unknown-casts` 禁止扩基线，需用户批准这批夹具重构的范围后再动
- [x] `publint`：`xingchen` 的 `files` 补齐 `lib/client.js` 与 `src`，导出不再悬空（publint exit 0）
- [ ] 阻塞：`duplication` 88 处克隆的消除属跨包大范围重构，需用户批准后再动
- [x] 里程碑：`constraints`、`verify-default-product-isolation`、`verify-product-use`、`verify-package-dependencies`、`publint` 全绿（`lint`、`verify-config-catalog`、`verify-config-source-ownership`、`verify-runtime-closure`、`verify-cordis-config` 此前已绿）

## 覆盖率豁免（56 个文件，逐批补用例并删豁免）

- [x] 批次 A 第一批：`session-format-v2-to-v3`（2 文件）、`session-format-v4-to-v5`（3 文件）、`session-persistence-jsonl/format.ts` 补分支用例并删除豁免（游标：豁免 56 → 50 个文件）
- [ ] 批次 A 第二批：`session-format-v3-to-v4/relationships.ts`、`session-persistence-sqlite/{persistence,sqlite}.ts` 的剩余分支（共享段删除、缺失 Trace 删除等）
- [ ] 批次 B：文件系统 seam 4 个文件
- [ ] 批次 C：星域 3 个文件
- [ ] 批次 D：其他 5 个文件
- [ ] 批次 E：A2A 9 个文件
- [ ] 批次 F：远端 SSH/SFTP 4 个文件
- [ ] 批次 G：CUA 4 个文件
- [ ] 批次 H：客户端面板 9 个文件
- [ ] 批次 I：Pi 循环 8 个文件
- [ ] 里程碑：`test:coverage` 全绿且豁免清单清零