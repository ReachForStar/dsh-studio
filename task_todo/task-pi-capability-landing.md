# 任务：pi 能力落地（8 项）

## 目标
把 `docs/wiki/queries/pi-capability-comparison.md` 的 8 项候选全部落地为本 fork 的代码能力，每项带测试并跑通门禁。

## 单元

### 1 虚拟模型路由
- [x] 核验 `agent-loop` 模型解析入口与 route 覆盖点
- [x] 定义 router 契约（request/reason/state）与会话投影持久化
- [x] 实现虚拟模型注册、解析与 state 读写
- [x] 测试 + 局部验证

### 2 classifier / image 非 LLM 模型
- [ ] 核验 `llm-pi-ai` 目录与调用路径
- [ ] 暴露 classifier/image 目录与一次性调用
- [ ] 定义会话记录与计价口径
- [ ] 测试 + 局部验证

### 3 codemode 工具注入式沙箱
- [ ] 核验 `ptc-runtime` 运行时抽象与工具注入点
- [ ] 设计沙箱运行时（工具调用 + store + 发现 + 预算）
- [ ] 实现 store 的会话投影持久化
- [ ] 测试 + 局部验证

### 4 提示模板
- [x] 核验 `interaction/commands` 注册与提交路径
- [x] 实现 Markdown 模板发现与参数展开
- [x] 接入命令发现与信任边界
- [x] 测试 + 局部验证

### 5 输入事件 handled
- [ ] 核验输入准入与 hook-protocol 事件面
- [ ] 实现 continue/transform/handled 三态
- [ ] 保证 handled 不写模型消息且反馈可见
- [ ] 测试 + 局部验证

### 6 会话标签
- [x] 核验 `session-projection` 与日志事件面
- [x] 实现标签读写（优先投影，避免换代）
- [x] 测试 + 局部验证

### 7 Git 检查点与 fork 恢复
- [ ] 核验 `experimental/worktree` 与 fork 交互
- [ ] 实现回合检查点与 fork 恢复
- [ ] 测试 + 局部验证

### 8 handoff
- [x] 核验 `followup` 与辅助调用记录
- [x] 实现上下文转移命令
- [x] 测试 + 局部验证

## 里程碑
- [x] 里程碑：第 4 项提示模板落地并通过验证
- [x] 里程碑：第 1 项虚拟模型路由落地；第 2 项 classifier/image 未开始
- [ ] 里程碑：第 3 项 codemode 沙箱落地
- [ ] 里程碑：第 5、6 项输入 handled 与会话标签落地
- [x] 里程碑：第 8 项 handoff 落地；第 7 项 git 检查点未开始
- [ ] 里程碑：全量 typecheck/lint/build:check 通过，wiki 回写
