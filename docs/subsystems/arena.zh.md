# 模型对比（Arena）

[English](arena.md) | 中文

实验性服务 [`dsh-arena`](../../packages/experimental/arena/README.zh.md) 提供 `ctx.arena`。它把同一提示同时交给多个模型，各自在一个从同一提交分出的 Git 工作树中执行，并返回可比较的结果。本页说明服务的对外接口；配置与请求字段由[包的 README](../../packages/experimental/arena/README.zh.md) 负责。

## 运行一次比较

`run()` 只解析一次基础提交，为每个参选者建立分支与检出，并为每个参选者启动一个普通会话，其工作目录就是该检出。每个会话以 `dsh-arena` 来源种类的用户消息收到提示并跑完一整轮，因此比较衡量的是模型本身，而不是它们共享工作树的能力。调用在所有参选者到达静止后返回；失败的参选者以 `status: "failed"` 与失败文本回报，而不是让整次运行失败。

比较数据来自投递的 `session/event`（轮次数、工具调用数、回复、适配器上报的用量），以及相对基础提交的 `git diff --cached`，因此从不提交的参选者也能给出完整改动集。被取消的运行把在收敛前停止的参选者标为 `status: "cancelled"`。

## 应用结果

`apply()` 把某个参选者的 diff 写成运行目录内的补丁文件，再应用到配置的工作区根。它不跑测试、不请求审批，也不检测与运行开始后新改动的冲突；何时接受哪个参选者由调用方决定。`remove()` 删除该次运行的工作树与分支，`runs()` 列出服务仍然保留的运行。

所有 git 命令都经 `subprocess` 与 `sandbox`，按 `sandboxPolicy` 解析出的策略执行，因此受限部署仍然保持写入边界。`worktreeRoot` 必须位于 `workspaceRoot` 之外，使比较用的检出不会落在被应用改动的工作区里。

## 保留与失败

运行会保留工作树直到调用 `remove()`，因此从不清理的部署会在 `worktreeRoot` 下累积目录。参选者会话在收敛后被释放；其持久化日志保留，并记录每个参选者的过程。释放失败会记入日志且不改变运行结果；无法删除的检出会被报告，但不阻止其余检出的删除。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxarena--arenaservice"></a>

### `ctx.arena` — `ArenaService`

Compare several models on one prompt and return their outcomes.

Each contender runs concurrently in its own checkout. The run never writes `workspaceRoot`: ArenaService.apply does that as an explicit, separate choice.

```ts cordis-catalog
/**
 * Run one prompt through every contender concurrently.
 * @param request - prompt, contenders, and optional base commit.
 * @param options - cancellation for the whole comparison.
 * @returns every contender's outcome, in request order.
 * @throws {Error} when the request is malformed, the repository cannot be read, or the run is cancelled before settlement.
 */
async run(request: ArenaRunRequest, options: { readonly signal?: AbortSignal } = {}): Promise<ArenaRun>

/**
 * Apply one contender's changes to the configured workspace root.
 * @param runId - run identity returned by {@link ArenaService.run}.
 * @param label - contender whose checkout supplies the diff.
 * @param options - cancellation for the git operations.
 * @returns paths the applied diff touched.
 * @throws {Error} when the run or contender is unknown, or the patch does not apply.
 */
async apply(runId: string, label: string, options: { readonly signal?: AbortSignal } = {}): Promise<string[]>

/**
 * Remove one run's checkouts and branches.
 * @param runId - run identity returned by {@link ArenaService.run}.
 * @param options - cancellation for the git operations.
 * @throws {Error} when the run is unknown.
 */
async remove(runId: string, options: { readonly signal?: AbortSignal } = {}): Promise<void>

/**
 * List the runs this service still retains.
 * @returns the retained runs, oldest first.
 */
runs(): readonly ArenaRun[]
```

Source: [`packages/experimental/arena/src/index.ts`](../../packages/experimental/arena/src/index.ts)
<!-- END GENERATED cordis-surface -->
