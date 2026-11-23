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
- [x] 扩展 `dsh-llm` adapter 契约、`llm-pi-ai` 实现与非 chat 委托
- [x] 核验 `llm-pi-ai` 目录与调用路径
- [x] 暴露 classifier/image 目录与一次性调用
- [x] 定义会话记录与计价口径
- [x] 测试 + 局部验证

### 3 codemode 工具注入式沙箱
- [x] 用 Node 内置 node:vm 实现沙箱运行时（无新依赖）
- [x] 核验 `ptc-runtime` 运行时抽象与工具注入点
- [x] 设计并实现沙箱运行时（工具调用 + store + 预算）
- [x] store 实现为进程内存（文档说明限制，不持久化）
- [x] 测试 + 局部验证

### 4 提示模板
- [x] 核验 `interaction/commands` 注册与提交路径
- [x] 实现 Markdown 模板发现与参数展开
- [x] 接入命令发现与信任边界
- [x] 测试 + 局部验证

### 5 输入事件 handled
- [x] 实现输入拦截服务（continue/transform/handled）并接入 prompt 准入
- [x] 核验输入准入与 hook-protocol 事件面
- [x] 实现 continue/transform/handled 三态
- [x] 保证 handled 不写模型消息（返回接受不入队）
- [x] 测试 + 局部验证

### 6 会话标签
- [x] 核验 `session-projection` 与日志事件面
- [x] 实现标签读写（优先投影，避免换代）
- [x] 测试 + 局部验证

### 7 Git 检查点与 fork 恢复
- [x] shell 执行、检查点存储（进程内存）与显式恢复命令
- [x] 核验 `experimental/worktree` 与 fork 交互
- [x] 实现检查点命令（显式捕获/恢复/清除）
- [x] 测试 + 局部验证

### 8 handoff
- [x] 核验 `followup` 与辅助调用记录
- [x] 实现上下文转移命令
- [x] 测试 + 局部验证

## 里程碑
- [x] 里程碑：第 4 项提示模板落地并通过验证
- [x] 里程碑：第 1、2 项虚拟模型路由与 classifier/image 落地
- [x] 里程碑：第 3 项 codemode 沙箱落地
- [x] 里程碑：第 5、6 项输入 handled 与会话标签落地
- [x] 里程碑：第 8 项 handoff 与第 7 项 Git 检查点落地
- [x] 里程碑：全量 typecheck/lint/build:check 通过，wiki 回写
