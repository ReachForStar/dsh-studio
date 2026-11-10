---
kind: upgrade-guide
description: "会话持久化后端必须实现新的抽象 delete 方法，Workspace 消费方新增永久删除会话的命令。"
---

# 会话持久化新增永久删除

[English](guide.md) | 中文

## 变更

`SessionPersistence` 新增抽象方法 `delete(id, options?)`。继承该类的后端在实现它之前无法编译。该方法永久删除一个已存储会话的完整持久产物集合；对已不存在的 id 返回 `false`；在本进程或另一进程持有写句柄时以 `SessionAlreadyOwnedError` 拒绝。它绝不触碰工作区文件与工作树。

Workspace Remote namespace 新增 `deleteSession({ sessionId })`，删除存储日志并从工作区记账、归档集合与置顶集合中清除该会话后返回 `{ deleted: boolean }`。仍打开的会话以 `workspace/session-open` 拒绝，仍有工作进行中的会话以 `workspace/session-active` 拒绝。右侧栏会话菜单与已归档行提供该操作；现有调用无需改动。

## 迁移

1. 在每个继承 `SessionPersistence` 的仓库外包中实现 `delete(id, options?)`：删除该 `id` 的完整产物集合，产物不存在时返回 `false`，写句柄持有时抛出 `SessionAlreadyOwnedError`。不要改动调用方拥有的状态，例如工作区记录或归档集合。
2. 用你的后端工厂运行 `@deepseek-ai/dsh-session-persistence` 提供的共享契约套件（`runPersistenceContract` 导出）；新增的删除用例必须与既有用例一同通过。
3. 如果你实现持久化 provider，请确认删除后的会话不再出现在 `stat` 与 `list` 中，重复 `delete` 返回 `false`，且写句柄打开时 `delete` 被拒绝。
4. 发布该包的新版本；只有当每个 provider 都实现完整抽象接口时，消费方才能接受这个 seam。
