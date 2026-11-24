# 收敛覆盖率债务（56 个豁免文件）

口径：本机资源（Kafka 9092–9094、sshd、Chromium、Pi 网关）只用于人工端到端验证，不进入覆盖率门禁；补的是可移植的单元用例。宿主资源 2026-11-24 实测结果与非覆盖率红项见 [fork 自研包的门禁红项清单](../docs/wiki/queries/fork-gate-debt.md)。

- [x] 里程碑：补 5 个文件的用例并删除豁免（session 头校验、llm 跨适配器、llm-pi-ai 外部助手来源、agent-preset-registry backend、sqlite 头解码）
- [x] 里程碑：修 `pi-agent-loop` 两个 e2e 的组装并实跑（补挂 `SessionProjectionRegistry`，AMAX 网关 `qwen3.8-flash-next-iq3_s`）
- [x] 核实本机资源并纠正债务分类，更新 `queries/fork-gate-debt.md`
- [ ] 会话格式与持久化 10 个文件：补历史编解码分支用例
- [ ] 文件系统 seam 4 个文件：补文本/字节 seam 用例
- [ ] 星域 3 个文件：补跳过与清理分支用例
- [ ] 其他 5 个文件：`agent-loop` Pi 后端路由、`workspace`、`api/session-controller`、`client/modules`、`client-runtime`
- [ ] A2A 9 个文件：在 kafkajs 假实现上补分支用例（本机 Kafka 只做人工验证）
- [ ] 远端 SSH/SFTP 4 个文件：用自带 `TestSshServer` 补错误路径与原子发布用例
- [ ] 客户端面板 9 个文件：补浏览器车道的面板块用例
- [x] 里程碑：`pi-agent-loop` 两个 e2e 的模型描述符改为 1M 上下文并实跑（2026-11-24）
- [ ] 阻塞：CUA 3 个文件（平台包已在本机，但面板分支需浏览器车道，且 `CuaDriverInstall` 安装流程需人工验证）
- [ ] 阻塞：Pi 循环 8 个源文件的单元分支需按 e2e 已验证的行为逐条补用例，待上述批次完成后处理
- [ ] 里程碑：`pnpm run test:coverage` 仍全绿且豁免清单逐批缩短
- [ ] 提交并推送