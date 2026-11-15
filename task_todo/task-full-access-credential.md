# 任务：A3 完全访问凭证

## 目标
把「完全访问」实现为独立提交动作：固定目标集合、写 receipt、忙时拒绝，不当作普通 allow。

## 可验证单元
- [x] 1. 新增 `approval/full-access` 会话事件与 receipt 投影（目标会话、模式、调用 id、轮次、reason）
- [x] 2. `ApprovalService.requestFullAccess()`：目标集合固定、忙时拒绝、写 receipt 与审计
- [x] 3. 客户端审批卡新增「完全访问」动作并二次确认（仅在请求声明可用时）
- [x] 4. 测试：目标固定、忙时拒绝、receipt 幂等、UI 动作与确认
- [x] 5. 验证：受影响包测试、`pnpm run typecheck`、`pnpm run test:docs`
- [x] 6. 知识沉淀：更新 handoff 页与 index/log，提交

## 验收
- 完全访问是显式提交动作，规则与自动应答者不能授予
- 目标集合固定，发布失败后重试复用原事件，不扩大授权
- 队列/审批忙时拒绝并给出可操作提示
- receipt 持久化且可重放；重复提交幂等
