---
description: "Tells a forked Session's model which background work belongs to the original conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-notice

English | [中文](README.zh.md)

## Summary

`dsh-fork-notice` tells a forked Session's model which work belongs to the original conversation. On the fork's first step it appends one sourced user message covering background subagents, background shells, schedules, follow-ups, and shared files, so the model does not wait for work that reports elsewhere or claim another conversation's results. Ordinary forks only: subagent children and non-seeded Sessions are left alone.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Mount the plugin in any composition that can fork Sessions. It has no configuration and no service dependency beyond the agent loop's `agent/pre-step` event.

```yaml
- name: '@deepseek-ai/dsh-fork-notice'
```

## Understand the implementation

The listener recognizes a fork child from its Session header: `isSeeded` set and `origin` not `subagent`. It acts only on the child's first turn and step, once per live Session, and returns the step's messages with the notice appended. The message therefore enters the log through the ordinary admission path; a resumed process does not repeat it because the child's first step has already passed.

### Dev Note

The notice is a normal user message so it survives replay and resumes without extra state: the child log itself records that the notice was delivered.

## Model Experience

### Fork ownership notice

#### What the model sees

One user message framed as `<fork-notice>` on the fork's first step. It states that inherited pending work belongs to the original Session and that files, branches, and services are shared.

#### Token effect

Roughly 140 tokens once per forked Session, on its first request only. The notice is not repeated on later steps.

#### KV Cache effect

The notice lands after the inherited prefix, so the inherited history's cache prefix is unchanged; only the new request tail differs.

## Known Limitations and Deferred Work

- The notice is skipped for forks resumed after their first step, and it does not distinguish forks created from a fork: the marker is structural, not lineage-aware.
