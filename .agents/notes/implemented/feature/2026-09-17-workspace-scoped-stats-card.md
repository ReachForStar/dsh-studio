# Agent Note: The stats float reports its workspace

Status: implemented

English | [中文](2026-09-17-workspace-scoped-stats-card.zh.md)

## Problem

The stats float reported the consumption of the session it rendered in. A user working in a workspace with several sessions therefore sees one card per rendered session, each answering for only that session, and no figure for the workspace the sessions belong to. What the user asked for is one card that answers for the whole workspace.

## Decision

The card reads the workspace of the session it renders in from `useWorkspaces` and sums the tokens of every session that workspace holds. A session reports its tokens through the `tokenUsage` projection value its row in the session list carries — the host projects those values for listed sessions, open or closed — and the session on screen reports its live projection instead, which is newer than its row. Cost is priced per session: a session whose settled messages this client holds is billed message by message, at each message's own model and settle time, while every other session is billed from its bucket totals at the card's `default` rate, because the wire projection carries totals per bucket with no model attribution. The per-model breakdown row therefore survives only when a single session contributed; the session timing groups stay what they always were — facts about the session on screen. A workspace the session list does not place falls back to the session's own figures, unchanged.

## Alternatives considered

**Aggregate on the host.** The rate card is a client-owned settings document the user edits, so the host cannot price a session; it would answer tokens only, in a second round trip, for a card that already has the values.

**Add a per-model usage wire projection.** It would make the workspace estimate exact, at the cost of a new persisted projection state, its schema version, and its cache rows — for one card, and for a breakdown the user did not ask for.

**Aggregate only the sessions the client has open.** That is the behavior the request rejects, and it makes the figure depend on which tabs a user happened to open.

## Consequences

A session whose projection was never cached contributes nothing until it is opened once, so a workspace total can under-count a session that has never been rendered. The total is exact for the session on screen and estimated for the rest, and the card re-aggregates whenever the session list or a projection changes. Package tests cover the sum across sessions, the live-over-listed precedence, the skip of empty rows, both pricing paths, the single-contributor attribution, the per-model row disappearing, and the fallback when no workspace lists the session.
