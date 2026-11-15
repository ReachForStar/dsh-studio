# 任务：codex/ZCode 交接与 hygiene 门禁

## 已完成
- [x] A1 命令前缀策略
- [x] A2 人工专属
- [x] A3 完全访问凭证
- [x] A4 会话级允许
- [x] A5 超时结果
- [x] B 上下文按节增量
- [x] C1 编辑降级匹配
- [x] C2 apply_patch（既有）
- [x] C3 文件回滚
- [x] D PermissionRequest / PreCompact / PostCompact 钩子
- [x] D 项目级钩子内容摘要与信任准入
- [x] D PreModelRequest / PostModelRequest 观测点
- [x] E 连续失败熔断与摘要模型回退
- [x] E 窗口重置（windowReset）
- [x] G memory_write 工具
- [x] G 召回选择器与字符预算
- [x] G 跨进程合并锁（MEMORY.md.lock）
- [x] H 域名允许清单
- [x] hygiene 四项门禁

## 未完成
- [ ] 阻塞：D updated_input 需要执行前的身份重写事务（工具审计、模型历史、呈现三处一致），并有 provider 回放兼容问题待实测
- [ ] 阻塞：E 后台推测压缩需要新的推测生命周期与安装/丢弃语义
- [ ] 阻塞：E 低峰调度需要为 schedule 增加模型覆盖字段并迁移 Host 任务存储格式
- [ ] 阻塞：E retained context 需要新的审查投影并定义保留范围
- [ ] 阻塞：F 类型检查需要引入 TypeScript 编译器运行时依赖与临时脚本落盘流程
- [ ] 阻塞：F 依赖图需要脚本 AST 分析依赖与新的展示通道
- [ ] 阻塞：F journal 重放需要按调用点持久化并定义中断后续跑语义
- [ ] 阻塞：G 后台提取需要会话结束后的辅助模型管线与写入去重预算
- [ ] 阻塞：H 代理与延迟审批需要新的沙箱网络代理与审批交互面
- [ ] 阻塞：H Provider 三层配置需要账号事实接入与选项映射编译
- [ ] 阻塞：H 诊断实验包含多个独立观测包，需分别立项
