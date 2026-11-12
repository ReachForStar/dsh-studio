# Agent Note: Loop and tool behaviors adopted from opencode v2

Status: implemented

English | [中文](2026-11-12-opencode-core-behaviors.zh.md)

## Problem

opencode v2.2.7 handles three recurring model-behavior failures that the harness also sees: a reply cut off at the output-token ceiling ends the turn mid-sentence, a tool call whose arguments have JSON types the schema did not expect fails as `INVALID_ARGS` and burns a recovery turn, and a forked Session's model treats inherited background work as its own. Each has a narrow fix, but each changes model-visible or model-facing behavior, so the default and the enforcement point need recording.

## Decision

Three separate behaviors, one per failure, with conservative defaults.

- **Bounded output continuation.** `AgentLoop` gains `maxOutputContinuations` (default `0`). When a step finishes `max-tokens` and the budget remains, the loop injects one sourced user message (`output-limit`) through the ordinary next-step inbox, so it is logged and replayable like any other user input. The turn-end reason stays `max-tokens` because it is sticky; later completed steps never erase the truncation fact. Deployments that want continuation set the value explicitly.
- **Argument repair before validation.** `defineTool` runs `repairArgs` on model-generated arguments before `validateArgs`. Only uniquely determined coercions apply: numeric strings to numbers/integers, `"true"`/`"false"` to booleans, numbers/booleans to strings, and JSON object/array text into the declared container, recursively through declared properties and array items. Anything ambiguous or still invalid reaches `ToolArgsError` unchanged, so the failure message still names every violation. The logged `tool/call` keeps the raw model arguments; presentation callbacks validate the raw value, so replay of older arguments cannot throw.
- **Fork ownership notice.** `dsh-fork-notice` adds one sourced user message (`fork-notice`) to a seeded, non-subagent Session's pre-step until the child-owned log already contains it. The notice states that inherited background work belongs to the original conversation and that files, branches, and services are shared. It is a normal user message: logged, replayable, and confined to the fork child.

## Alternatives considered

**Continue truncated replies by default.** It changes every deployment's turn count and cost without the operator asking; a model that legitimately stops at the ceiling (large file dumps) would be pushed to keep going. The config value keeps the capability available without changing shipped behavior.

**Repair inside each tool.** Duplicating coercion per tool leaves some call paths unrepaird and keeps schema knowledge in every implementation; `defineTool` is the one place both native and PTC transports validate.

**Rewrite logged arguments to the repaired value.** The session log must record what the model actually sent; presentation and policy read that value, and a silent rewrite would make replay diverge from the model's input.

**Inject the fork notice as a system message or a prompt section.** A prompt section applies to every Session, and a system message would move the fact out of the ordinary user-message surface that forks already inherit and review.

## Consequences

Continuation costs one extra request per truncation up to the configured budget and keeps a `max-tokens` turn outcome even when the continuation completes. Repaired arguments change the value a tool body receives while the log keeps the raw call, so a tool that compares logged and executed arguments must compare normalized values. The fork notice appears once per forked Session and is skipped when descendants fork again, so a fork of a fork receives its own notice only if it is itself seeded.
