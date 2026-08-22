# Agent Note: 修复 ui-polish 自动压缩在轮次中途调用仅限空闲的手动 API

Status: implemented

[English](2026-08-22-ui-polish-auto-compaction-busy.md) | 中文

## 问题

`dsh-client-ui-polish` 让用户挑选会话在哪个上下文压力比例下压缩（低于 harness 默认值 0.8）。其 `compaction-control.ts` 拦截 `agent/pre-step` 并调用按 agent 寻址的 `compaction.compactNow(agent, signal)`。`compactNow` 是显式的空闲会话 API：它通过 `runMaintenance()` 进入 agent maintenance，而后者在 agent 阶段不是 `idle` 时同步抛错。pre-step 监听器在阶段为 `running` 时执行，因此每次自动尝试都抛出 `ManualCompactionError('busy')`，被吞成逐步骤告警，从未真正压缩——上下文持续越过用户设定的比例增长，直到 harness 自身的 0.8 监听器或手动 `/compact` 介入。当用户在流式回复期间尝试 `/compact` 时，同样的 busy 错误也会呈现给用户，于是这个损坏的拦截看起来就像「自动压缩失效，并且阻碍手动压缩」。

## 决策

轮次中途安全的 seam 方法是 `compactIfNeeded(agent, 'pressure', signal)`，它拥有范围选择、保留策略、重试与持久化锁标记；内置自动监听器早已在同一事件上使用它。它所缺少的是调用方把压力线降到后端配置阈值之下的途径。因此：

- compaction Service Definition（`dsh-compaction`）在 `compactIfNeeded` 上新增可选按调用参数 `options?: PressureTriggerOptions`；`thresholdRatio` 仅在该次调用中覆盖后端配置的阈值。
- `dsh-compaction-basic` 在 `resolveCompactSpec(policy, contextWindow, override?)` 中兑现它：压力线随覆盖值缩放，保留与重试预算仍归后端所有，既有的 `retainTokens < thresholdTokens` 校验仍然生效。
- `ui-polish` 现在自身不做测量；配置了低于 0.8 的比例时调用 `compactIfNeeded(agent, 'pressure', signal, { thresholdRatio: ratio })`，在等于或高于 0.8 时保持 no-op。内置监听器随后测得压力低于用户比例（< 0.8），不会重复压缩。

手动 `/compact` 不受影响：`compactNow` 仍独占空闲维护路径，绝不在轮次中途被调用。

## 备选方案

**保留 `compactNow` 并让它容忍 running 阶段。** 拒绝：`compactNow` 的契约是空闲维护预留（扣留唤醒输入、在队列回放前 flush）；把它放宽到轮次中途的工作会与 `compactIfNeeded` 重复，并模糊手动 API 的保证。

**从 host 侧重新配置 compaction-basic。** 拒绝：Web 组合把 compaction-basic 挂进 agent preset 的隔离 realm，正是为了让 host 插件无法触及或重配该实例；按调用覆盖保持策略静态，拦截只留在 ui-polish 内部。

**向 host 插件暴露范围选择（`selectCompactableRange`）。** 拒绝：会迫使 ui-polish 重实现选择、保留与重试策略而非复用后端实现，并把后端内部细节泄漏到 seam。

## 测试

`compaction-basic.spec.ts` 在 `resolveCompactSpec` 层级（比例线缩放、保留不变、非法比例与保留冲突被拒）和 `compactIfNeeded` 层级（带覆盖值在配置比例线之下压缩；覆盖值抬高比例线时保持不压缩）都覆盖了按调用覆盖。seam、command-compact 与 ui-polish 的套件均原样通过。

## 后果

- 低于 0.8 的用户配置比例现在能真正在轮次中途压缩，走的是与内置 0.8 监听器相同的成熟路径。
- 逐步骤的 busy 告警刷屏消失，手动 `/compact` 不再与失败的自动尝试竞争。
- seam 只新增了一小块附加面；可选参数意味着其他后端不受影响，生成的 Cordis API 目录与子系统页面会同步该签名。
