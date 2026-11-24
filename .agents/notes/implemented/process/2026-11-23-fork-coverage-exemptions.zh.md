# Agent Note: 将 fork 能力文件从 per-file 覆盖率门禁中豁免

Status: implemented

[English](2026-11-23-fork-coverage-exemptions.md) | 中文

## Problem

`pnpm run test:coverage` 对 `packages/*/*/src` 的每个文件要求 100%。本 fork 自研能力涉及的 61 个文件在无密钥的单机运行中达不到该标准：A2A 总线需要 Kafka 与对等端，SFTP 与 SSH provider 需要 POSIX 服务，CUA 需要原生 helper，Pi 循环需要模型密钥，若干客户端面板需要 jsdom 车道不具备的浏览器测试环境。[fork 门禁红项页](../../../../docs/wiki/queries/fork-gate-debt.md) 曾把它们记为红项，结果是门禁长期失败，新回归也淹没在同一份清单里。

## Decision

覆盖率配置用名为 `Fork capability debt` 的块把这些文件登记进 `coverage.exclude`，每项写一个文件或一组精确文件，并写明上面的理由。其余包（包括带 fork 改动的上游包）继续执行 per-file 100%。新增 fork 能力不得静默加入该清单：只有写明日期与理由才能进入，补上传记用例后必须删除对应行。只差一两条分支的文件补用例，不加豁免。

## Alternatives considered

**现在补齐全部用例。** 本批不选：涉及需要外部服务的 provider，补出来的会是对环境敏感的 e2e，而不是单元覆盖。

**降低全局阈值。** 不选：等于为少数文件削弱所有包，而 per-file 规则正是防止大文件补贴空文件。

## Consequences

覆盖率门禁重新变绿，并能报出真实回归。被豁免的文件作为可见债务集中在一处，评审可以拒绝新增条目，并要求给出移除旧条目所依赖的具体用例。
