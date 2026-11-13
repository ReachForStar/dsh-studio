# Model comparison (Arena)

English | [中文](arena.zh.md)

The experimental [`dsh-arena`](../../packages/core/arena/README.md) service provides `ctx.arena`. It runs one prompt through several models at once, each in its own Git worktree branched from the same commit, and returns comparable results. This page owns the service surface; the [package README](../../packages/core/arena/README.md) owns configuration and the request fields.

## Running a comparison

`run()` resolves the base commit once, creates one branch and checkout per contender, and starts one ordinary Session per contender whose working directory is that checkout. Each Session receives the prompt as a `dsh-arena` user message and runs a complete turn, so the comparison measures the models rather than their ability to share a tree. The call resolves after every contender reaches quiescence; a contender that fails reports `status: "failed"` with its failure text instead of failing the run.

Comparison data accumulates from delivered `session/event` messages — turns, tool calls, the reply, and adapter-reported usage — and from `git diff --cached` against the base commit, so a contender that never commits still yields a complete change set. A cancelled run reports `status: "cancelled"` for contenders that stopped before settlement.

## Applying a result

`apply()` writes one contender's diff to a patch file inside the run directory and applies it to the configured workspace root. It never runs tests, asks for approval, or detects conflicts with changes made after the run started; the caller decides when and whether to accept a contender. `remove()` deletes the run's checkouts and branches, and `runs()` lists the runs the service still retains.

Every Git command runs through `subprocess` and `sandbox` with the policy `sandboxPolicy` resolves, so a confined deployment keeps its write boundary. `worktreeRoot` must live outside `workspaceRoot`, which keeps comparison checkouts out of the workspace a winner is applied to.

## Retention and failure

A run keeps its checkouts until `remove()` is called, so a deployment that never removes them accumulates directories under `worktreeRoot`. Contender Sessions are disposed after settlement; their persisted logs remain and hold each contender's transcript. Disposal failure is logged and does not change the run result, and a checkout that cannot be removed is reported without stopping the remaining removals.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Source: [`packages/core/arena/src/index.ts`](../../packages/core/arena/src/index.ts)
<!-- END GENERATED cordis-surface -->
