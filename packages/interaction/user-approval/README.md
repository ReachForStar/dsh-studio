---
description: "Channel-neutral one-shot approval seam for users and maintainers composing answerers, setting policy, or debugging fail-closed permission decisions."
kind: "package-reference"
---

# @deepseek-ai/dsh-user-approval

English | [中文](README.zh.md)

## Summary

Use this package to require a one-shot decision before a sensitive tool action proceeds. The `ask` policy sends each request to the deployment's human or machine answerers; `never` rejects it without prompting. Missing or failed answerers return `unavailable`, so the action fails closed, and an approval applies only to that request. Every request and outcome is recorded in the requesting session's audit log. The model sees the resulting tool outcome and current policy, but not the human permission UI or audit events.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose this service when sensitive tool actions should pause for a human or machine decision instead of running unconditionally. It requires `sessionProjections`; shipped profiles already provide that service. The tools pipeline and the sandboxed bash tool route their `ask` decisions through this seam and fail closed when it is absent, so interactive deployments mount it with at least one answerer.

### Composing answerers

Answerers are `approval/request` waterfall listeners: return an outcome to answer for an owned agent, or call `next()` to delegate. Agent-scoped listeners receive only that agent's requests, and a deployment composes one terminal answerer — sibling listener order is not a policy-priority mechanism. Without a terminal answerer, requests resolve `unavailable` and fail closed; the service itself never prompts a human.

### Setting the policy

The effective policy is the one set for the session, falling back to the configured default. `ask` (the default) delegates to the composed answerers; `never` rejects every request deterministically before interactive dispatch — the strict headless stance for CI and unattended runs.

```yaml
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask
    rules:
      - action: write
        resource: docs/**
        effect: allow
      - action: bash
        resource: 'git *'
        effect: allow
```

| Field | Default | Meaning |
|---|---|---|
| `policy` | `ask` | Default for sessions without an `approval/policy` override |
| `rules` | `[]` | Ordered `{action, resource, effect, match}` rules evaluated before the policy and the answerers |
| `timeoutMs` | `0` | Milliseconds one request may wait for an answerer; `0` waits until an answer or cancellation |

### Rules

Rules decide a request before the session policy and before any answerer. Each rule names an action pattern, a resource, an effect (`allow`, `deny`, or `ask`), and a match mode. `*` matches any run of characters — including path separators — and `?` matches exactly one character. The last matching rule wins, so a narrow exception can follow a broad rule.

`match: 'glob'` (the default) treats the resource as a pattern. `match: 'prefix'` treats it as a literal command prefix and compares whole command words, so `git status` grants `git status -s` but never `git statuspage`, another subcommand, or a command joined with `&&`. Quoting and backslash escapes are honored; control operators, redirection, command substitution, subshells, expansion, and unterminated quotes make the command ineligible, so it asks instead of matching.

A rule matches when its action pattern matches the request's action and, for a request with declared resources, at least one resource matches; a request without resources matches only a `*` resource. A matching `allow` settles `allowed-once` without prompting, a matching `deny` settles `rejected`, and `ask` (or no match) continues to the policy and answerers. Rules never grant more than the request they matched, and a request marked `needsHuman` is never granted by a rule.

Tools supply the action and resources through their definition: `write` and `edit` declare `write` with the target path, and `bash` declares `bash` with the command text. Any other tool, or a classifier that throws, falls back to its own tool name with no resources, so an unexpected classifier can only make a rule less specific, never wider. Because rules precede the `never` policy, an unattended run can permit exact actions while rejecting everything else.

### Project and session rules and `/allow`

When a storage domain is mounted, the service also keeps rules per project directory in the `approval_rules` domain. Stored rules are appended after the configured ones, so they can narrow or extend them. `--session` rules live only in memory for the live Session and are evaluated after project rules; ending the Session drops them and a restart cannot resurrect them. The `/allow` command edits the invoking Session's project rules, or its session rules with `--session`:

| Input | Result |
|---|---|
| `/allow [--session] [--prefix] <action> <resource> [allow\|deny\|ask]` | Appends one rule; the effect defaults to `allow`, and `--prefix` stores a literal command prefix |
| `/allow [--session] list` | Lists the scope's rules with 1-based positions |
| `/allow [--session] remove <n>` | Removes the rule at position `n` |
| `/correct <callId> <text>` | Records replacement arguments for a pending call |

`/correct` records the text against the exact tool call; when the user then rejects that call, the model receives `the user rejected tool "…" and asked you to retry with corrected arguments: <text>` as the failure reason and can retry. Reading the correction consumes it, so a later rejection cannot reuse it.

A Session without a recorded working directory refuses the `/allow` command. `addProjectRule(cwd, rule)`, `removeProjectRule(cwd, index)`, and `projectRulesFor(cwd)` are the same operations for Host callers. Without a mounted storage domain, project rules stay empty and the mutators reject.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-user-approval) is the exhaustive source for every accepted field and its JSDoc. `setPolicy(agent, policy)` switches a live agent and queues the switch notice described under Model Experience for its next model step; `setApprovalPolicy(session, policy)` is the direct durable write path used by session initialization.

### Requesting a decision

`request(req)` names the agent, tool, optional call id and reason, and an abort signal. It mints the request identity answerers receive as `requestId`; while a full-access applier is registered the dispatched request also carries `fullAccess: true`. Optional `displayReason` supplies localized presentation text without changing the logged reason. Set `needsHuman` when the decision must come from a person: rules cannot auto-allow such a request (a rule's `deny` still applies), and automated answerers must delegate with `next()` instead of deciding; sandbox escalation sets it. The configured `timeoutMs` may settle a request `timed-out` without a decision; a late answer is discarded. It requires an open turn: an idle or between-turn caller throws before auditing anything. Aborting withdraws the question — the request settles `cancelled` and a late answer is discarded. A failure that prevents either audit append from committing rejects instead of returning an unlogged decision.

`registerFullAccess(handler)` installs the single applier of an explicit full-access commit and withdraws it with the returned disposer; `isPending(session, requestId)` reports whether a prompt still waits. `requestFullAccess(agent, requestId)` records that commit. It refuses a prompt that already settled (`FULL_ACCESS_STALE`), a second commit for the same session while the first is still settling (`FULL_ACCESS_BUSY`), and a composition without an applier (`FULL_ACCESS_UNAVAILABLE`). The first commit appends one `approval/full-access` receipt holding the input identities pending at that moment; a retry for the same request reuses the receipt instead of covering input queued later. The registered applier runs after the receipt commits, so a failing applier leaves a retryable grant with the same fixed targets.

### What the model and user see

The model sees only the asking consumer's eventual tool outcome — allowed, rejected, cancelled, or unavailable — plus the current policy in the runtime-context snapshot; the audit events and the human permission UI are not model context. Each policy switch is announced to the model by a sourced user message, and both policies contribute their complete current meaning to the snapshot.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains dispatch, policy enforcement, and the audit path.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `ApprovalService`: request dispatch, private approval state, policy write path, runtime-context contribution |
| [`src/types.ts`](src/types.ts) | `ApprovalRequestId` brand and outcome types |

### Dispatch

`decide()` races the answerer waterfall against the request signal and contains every answerer failure: a throwing listener fails the question closed to `unavailable`, and a rogue non-vocabulary return is normalized to `unavailable`. The `never` policy is enforced inside the service before waterfall dispatch, so a listener registered later with `prepend` cannot bypass the deterministic rejection. The request must be turn-enclosed because the turn is the durable log's commit/replay boundary — a bare event between turns is indistinguishable from a crash tail.

### Policy and the runtime-context snapshot

The private host-only `approvalState` projection stores the policy override and whether a turn is open. Its size does not grow with the number of events. The registry includes it in persisted checkpoints; the event log remains authoritative. Its pure updates never dispatch questions or grant permission.

Service activation waits for projection registration and fails if registration fails. The service keeps the returned reader private. The host and registry own Session recovery; approval methods do not load history or call hydration from a synchronous read. See the [registration and recovery API](../../session/session-projection/README.md). Pending questions, answerers, and grants remain in the runtime.

The system-prompt contribution `approval:policy` states the complete current meaning of the effective policy — `ask` with its fail-closed consequence, or `never` with its non-escalation consequence — after retained history, so switching policy appends a new full snapshot instead of rewriting the stable request header. `setPolicy()` also injects a sourced user message announcing the change for the next step.

### Audit

`request()` appends `approval/asked` with the request identity and tool, then `approval/decided` with the closed outcome; the exact appended fields live in [`src/index.ts`](src/index.ts). `requestFullAccess()` appends one `approval/full-access` receipt for the same request identity. All three are log-only.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the approval vocabulary to the consumers and the design rationale.

- [Approval subsystem reference](../../../docs/subsystems/approval.md) — the shared request/outcome vocabulary and the `ctx.approval` Cordis surface.
- [Approval seam Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-approval-seam.md) — design rationale for the seam.
- [Sandbox reference](../../shell/tool-bash/README.md) — how the sandboxed bash tool consumes approvals for escalated retries.
- [Interaction group map](../README.md) — adjacent permission preset and question packages.

-----

<a id="model-experience"></a>
## Model Experience

### Current approval policy context

#### What the model sees

The first request and each effective policy change append a full runtime-context snapshot after retained history. Under `ask`, the approval contribution states that configured answerers may be consulted and absence fails closed. Under `never`, it states the deterministic rejection and non-escalation consequence. Unchanged requests retain the earlier snapshot without adding another message. When the user switches a live Session's policy, the next model step also receives a switch notice.

##### Ask-policy contribution

```markdown
Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.
```

##### Never-policy contribution

```markdown
Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).
```

##### Switch notice

```markdown
The user changed the approval policy from "ask the user for approval" to "never ask the user for approval".
```

#### Token effect

One concise context message on the first request and on an effective change; unchanged requests add no duplicate policy tokens.

#### KV Cache effect

Append-only after retained history. An `ask`/`never` switch preserves the stable system and conversation prefix instead of rewriting the first wire message.

### Tool outcome

#### What the model sees

`approval/asked` and `approval/decided` are log-only. The model sees only the asking consumer's eventual allowed, rejected, cancelled, or unavailable tool outcome; the human permission UI is not context.

#### Token effect

Zero duplicate audit tokens. A rejection may replace a normal tool result with a small retained error, while an allowance leaves the consumer's ordinary result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam is a poor fit or needs special composition care. They are current package constraints, not a general permission comparison.

- **Requests are valid only inside an open turn** — an idle or between-turn caller throws before auditing; a durable out-of-turn approval workflow is deferred.
- **No runtime grant store** — the outcome vocabulary has `allowed-once` but no `allow-always` outcome, revocation API, or grant store; `/allow` rules are explicit configuration and `--session` rules live only in memory. Session policy is only `ask` / `never`.
- **The request carries no tool arguments** — an answerer sees the tool name, reason, and optional call id; the ACP machine channel requires a call id and delegates requests without one.
- **No built-in answerer** — headless or incompletely composed deployments resolve `unavailable` and fail closed; the service itself never prompts a human.
- **Pending approvals are process-local** — checkpoints restore policy and turn state, not pending answerer promises or one-shot grants. Recovery does not resubmit questions or repeat runtime effects.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
