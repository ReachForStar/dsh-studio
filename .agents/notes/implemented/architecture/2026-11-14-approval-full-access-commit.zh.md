# Agent Note：完全访问是审批提交，不是允许规则

Status: implemented

[English](2026-11-14-approval-full-access-commit.md) | 中文

## 问题

被要求批准一次受限操作的人，可能得出的结论是：这个会话之后都应当不受限制地运行。把该结论实现成又一条 `allow` 规则有两处错误：规则是比命中的请求更宽的持久模式；它还会覆盖人看到提示之后才排队的输入。codex 与 ZCode 都采用同一个动作——带持久回执与忙时检查的独立提交——但它们的会话模型还会把模式写到每个排队项上。

DSH 在执行时从会话投影解析沙箱模式，因此模式切换本来就会作用到每个排队项；没有需要逐项写入的字段。真正需要归属的是这个动作本身：授权了哪个提示、覆盖了什么，以及同一提示被回答两次或另一个授权正在结算时会发生什么。

## 决策

`dsh-user-approval` 拥有提交与回执。`request()` 现在生成请求身份，应答者以 `requestId` 收到；注册了执行器时，分发的请求带有 `fullAccess: true`。`registerFullAccess(handler)` 注册唯一的执行器。`requestFullAccess(agent, requestId)` 要求那个确切的提示仍在等待，拒绝同一会话的并发提交，追加一条记录仍在排队输入身份的 `approval/full-access` 回执，然后才运行执行器。对同一请求的重试复用该回执，而不是重新取目标快照，因此首次提交之后排队的输入不会进入授权。执行器失败时回执保留，可用相同目标重试。

`dsh-permission-presets` 拥有完全访问的含义：它注册执行器，并通过与 `/permission` 相同的写入路径应用 `fullAccessPreset`（默认 `danger-full-access`）。显式配置但缺失的预设会在加载期失败；替换表只是不含内置默认项时则撤下该动作。浏览器通过 `/full-access <requestId>` 到达提交，命令成功后才回答提示，因此被拒绝的提交会让提示保持打开。

回执是审计记录，绝不是规则：它不会为之后的请求授予任何权限。`SESSION_FORMAT_VERSION` 保持不变，因为不认识的必需事件会让旧读取方拒绝日志，而不会把缺失的授权解释为未授权。

## Alternatives considered

- 新增 `allowed-full-access` 审批结果可以让应答者直接返回扩权，但会把策略应用放进审批 waterfall，并失去“回执先行”带来的可重试性。
- 从提示派生持久规则正是本改动拒绝的行为：它比提示活得更久，并覆盖人没看到的输入。
- 在客户端做目标快照会让迟到的命令把授权扩大到这个提示覆盖范围之外。

## 后果

应答者与客户端多看到两个可选请求字段；旧客户端忽略它们，保留两种结果的卡片。执行器是唯一允许写入更宽策略的组件，因此未组合 `dsh-permission-presets` 的部署不声明完全访问动作，而不是每次点击才失败。并发提交被拒绝而不是串行化，从而把这个“一次一个”的规则暴露给用户，而不是静默合并两个授权。

验证：`packages/interaction/user-approval/tests` 覆盖回执、固定目标、幂等重试、过期提示、缺少执行器与忙时拒绝；`packages/interaction/permission-presets/tests/full-access.spec.ts` 覆盖预设应用与 `/full-access` 命令；`packages/client/ui-approval/tests` 覆盖受控动作、确认勾选与命令失败行为。
