# 债务清单盘点（2026-11-24）

- [x] 里程碑：核实 56 个覆盖率豁免文件的分类（22 个只缺单元用例、34 个曾卡在外部车道）
- [x] 里程碑：实测宿主资源（Kafka 9092–9094 可连、`ssh.service` 监听 22、Playwright Chromium、`@trycua/cua-driver-linux-x64-gnu` 平台包、Pi 网关）
- [x] 里程碑：Pi 两个 e2e 的模型描述符改为 1M 上下文并用该网关实跑（2 项通过）
- [x] 提交五个豁免文件的用例收敛与 1M 上下文（`test(coverage)` 批）
- [x] 把非覆盖率红项实测结果写入 `queries/fork-gate-debt.md` 与 `log.md`
- [x] 提交 wiki 与任务清单
- [ ] 阻塞：后续覆盖率批次与门禁红项修复待用户确认顺序；webhook 归属（提回稳定包或从 Web 组合摘除）改动产品面，需单独授权