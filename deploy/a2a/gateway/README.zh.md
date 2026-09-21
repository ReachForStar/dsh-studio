# A2A 网关（源码已入库）

[English](README.md) | 中文

承载星域专家席的三台 A2A 网关源码，从 `a2a-bridge` 项目（提交 `fdaf67b1b9c7e5809744a6764707a602be8474ed`）迁入本仓库，使本地联调栈完全自包含。栈启动器（`deploy/a2a/stack.mjs`）拉起的就是这里的网关；用 `A2A_BRIDGE_DIR` 可改指向其它检出。

## 目录

| 路径 | 内容 |
| --- | --- |
| `packages/shared/` | A2A 协议类型、Kafka 总线客户端、配置加载、子进程辅助 |
| `packages/pi-gateway/` | pi coding-agent 网关（端口 9310） |
| `packages/cc-gateway/` | Claude Code 网关（端口 9320） |
| `packages/oc-gateway/` | opencode 网关（端口 9330） |
| `cli/` | 运维命令：`status.mjs`、`agents.mjs`、`dispatch.mjs`、`push.mjs`、`bus-smoke.mjs` |
| `config/` | 项目自带默认值：`config.json`（端口、总线主题、模型）与 `opencode.json` |
| `e2e/run.mjs` | 对真实网关的端到端运行 |

## 构建与运行

```sh
cd deploy/a2a/gateway
npm ci
npm run build
```

`npm run build` 执行 `tsc -b`，产出 `packages/*/dist/index.js`，栈启动器执行的就是这些文件。网关在设置了 `A2A_CONFIG` 时读它；栈启动器把它指向 `deploy/a2a/a2a.config.json`，因此 harness 与网关共用同一份配置。没有该变量时网关回退到自带的 `config/config.json`。

单独启动某一台网关，在本目录执行：

```sh
npm run start:pi     # 9310
npm run start:cc     # 9320
npm run start:oc     # 9330
```

## 派发冒烟

```sh
node cli/dispatch.mjs --to opencode --skill analysis --input "reply with two words" --mode direct --timeout 180000
```

会打印任务状态与最终结果 JSON；出现 `TASK_STATE_COMPLETED` 且文本符合预期，说明网关、其代理后端与模型路由都正常。

## 说明

- `node_modules/`、`dist/`、`*.tsbuildinfo` 均已忽略：检出后自行构建产物。
- 原本与这份源码同处的知识库没有一并搬入；本仓库需要的内容记在 harness 的 wiki（`docs/wiki/entities/local-a2a-stack.md`）。
- Kafka 集群定义在本仓库的 `deploy/a2a/kafka/docker-compose.yml`。
