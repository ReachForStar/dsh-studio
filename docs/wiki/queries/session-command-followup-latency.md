---
title: 回复延迟：codearts 上游排队导致每步等待
type: query
tags: [session, latency, llm, magpie]
created: 2026-10-29
updated: 2026-10-29
sources: []
status: active
---

# 回复延迟：codearts 上游排队导致每步等待

## 问题

2026-10-28 的本机 dsh 会话一轮回复耗时 80–97 分钟（`fded23b5` 轮 1 为 80.1 分钟 / 59 步，`9d182a87` 为 83.1 分钟 / 64 步，`d4915a83` 为 97.1 分钟 / 95 步），其中首字等待合计 74.7–91.5 分钟。本页取代 2026-10-29 早先的待确认结论「输入规模可能相关」。

## 根因

等待发生在 magpie 网关到上游这一段，且主要是网关侧的排队，不是 dsh 本地处理。

- 网关逐请求日志（`~/.config/magpie/routing/<日期>.jsonl(.gz)`）每条请求带 `ttft`、`ms` 与 `tries[].queued`（等待调度出发的毫秒数）。2026-10-28 09:00–11:00 时段，四个 dsh 会话的请求首字中位 63–73 秒，其中排队 56–62 秒，约占首字等待的 85–90%；同期 `pi` 会话的 48 个请求排队 0 秒、首字中位 8 秒。
- 该时段对 `codearts` 上游的同时占用峰值为 5 个请求。`~/.config/magpie/providers.json` 里 `codearts` 是唯一设了并发上限的提供方：`maxConcurrency: 1`、`queueLimit: 8`；其余提供方未设置该字段。
- 同一时段同账号的兄弟模型 `codearts/deepseek-v4.1-flash` 首字中位 7.9 秒、排队 0 秒；10-27 20:00–22:00 同一 `codearts/deepseek-v4.1-flash-1017` 路由首字 12–18 秒、排队 0 秒。慢的是 1017 快照这一路在拥堵时段的调度等待，不是该账号的固定属性。
- 四天（10-26 至 10-29）共 5500 条网关请求中，`codearts/deepseek-v4.1-flash-1017`：n=629，首字中位 27.1 秒、p90 83.3 秒、最大 212 秒，超过 60 秒的有 176 次。同网关对照路由的首字中位：`qoder-cn/dfmodel` 2.8 秒（n=2558）、`workbuddy/deepseek-v4.1-flash` 3.5 秒（n=621）、`opencode-go/deepseek-v4.1-flash` 8.2 秒（n=160）、`codearts/deepseek-v4.1-flash` 8.8 秒（n=994）、`codearts/glm-5.3` 15.1 秒（n=245）。
- 本地开销可忽略：`session.v5.jsonl` 事件里上一条记录到 `step/start` 的中位间隔 18 毫秒（最大 45 毫秒）；把 924 个步骤与网关日志按请求起始时间对齐后，`dsh 首字等待 − 网关 ttft` 中位 36 毫秒。
- 同一会话内的模型对照最直接：`session-df2543ae` 步骤 1–46 走 `codearts/deepseek-v4.1-flash-1017`，首字 2.5–187 秒（多数 60–107 秒）；切到 `amax/deepseek-flash` 后步骤 47–51 首字 15.8、4.4、5.9、3.3、2.2 秒，后续各轮 0.3–1.0 分钟。

由于一轮回复要串行几十步，每步多等约一分钟就累计成整轮的几十分钟。

## 解法

1. 换掉该路由：在 dsh 会话里选 `amax/deepseek-flash`（profile 默认）、`qoder-cn/dfmodel` 或 `workbuddy/deepseek-v4.1-flash`，同规模提示首字中位 1.8–4.0 秒。
2. 或调整网关侧 `codearts` 的 `maxConcurrency` / `queueLimit`。属于改本机网关配置，且上游可能因此限流，需要先确认。
3. 避免多个 dsh 会话同时使用 codearts 路由。

## 涉及模块

- [llm-pi-ai（pi-ai 适配器与提供方路由）](../entities/llm-pi-ai.md)：`magpie` 提供方指向本机网关，模型 id 直接决定上游路由。
- [本地 A2A 联调栈（部署与运行期日志）](../entities/local-a2a-stack.md)：同类「运行期日志落盘、按日志定位」的做法。
- `packages/core/agent-loop/src/agent.ts`：`step/start` 到 `assistant/message` 的区间是本页测量的首字等待。

## 复发预防

- 报告延迟先看 `ttft` 与 `queued` 两个字段，再决定动 dsh 还是动网关；`step/start` 到首个片段的耗时里，本地部分与网关首字之差中位只有几十毫秒。
- 网关日志按天分片、按调用方与 `session` 记录，可用来在改动前建立基线：读 `~/.config/magpie/routing/<日期>.jsonl(.gz)`，按 `tries[].queued` 与 `ttft` 拆分排队和上游两段。
- 同账号不同模型快照的延迟可以差一个数量级，选模型时把「上游路由」与「模型名」分开看。