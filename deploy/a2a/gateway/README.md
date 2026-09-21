# A2A gateways (vendored source)

English | [中文](README.zh.md)

Source of the three A2A gateways that host the star-domain specialist seats, vendored from the `a2a-bridge` project (commit `fdaf67b1b9c7e5809744a6764707a602be8474ed`) so that this repository carries the whole local stack. The stack launcher (`deploy/a2a/stack.mjs`) starts these gateways; `A2A_BRIDGE_DIR` overrides the location with another checkout.

## Layout

| Path | Contents |
| --- | --- |
| `packages/shared/` | A2A protocol types, Kafka bus client, configuration loading, child-process helpers |
| `packages/pi-gateway/` | pi coding-agent gateway (port 9310) |
| `packages/cc-gateway/` | Claude Code gateway (port 9320) |
| `packages/oc-gateway/` | opencode gateway (port 9330) |
| `cli/` | operator commands: `status.mjs`, `agents.mjs`, `dispatch.mjs`, `push.mjs`, `bus-smoke.mjs` |
| `config/` | the project's own defaults: `config.json` (ports, bus topics, models) and `opencode.json` |
| `e2e/run.mjs` | end-to-end run over the real gateways |

## Build and run

```sh
cd deploy/a2a/gateway
npm ci
npm run build
```

`npm run build` runs `tsc -b` and produces `packages/*/dist/index.js`, which is what the stack launcher executes. The gateways read `A2A_CONFIG` when set; the stack launcher points it at `deploy/a2a/a2a.config.json`, so the harness and the gateways share one configuration. Without that variable the gateways fall back to their own `config/config.json`.

Single gateway, from this directory:

```sh
npm run start:pi     # 9310
npm run start:cc     # 9320
npm run start:oc     # 9330
```

## Dispatch smoke

```sh
node cli/dispatch.mjs --to opencode --skill analysis --input "reply with two words" --mode direct --timeout 180000
```

Prints the task states and the final result JSON; `TASK_STATE_COMPLETED` with the expected text means the gateway, its agent backend, and the model route all work.

## Notes

- `node_modules/`, `dist/`, and `*.tsbuildinfo` are ignored: the checkout builds its own artifacts.
- The knowledge base that lived beside this source in the `a2a-bridge` repository is not copied here; the harness wiki carries what this project needs (`docs/wiki/entities/local-a2a-stack.md`).
- The Kafka cluster definition lives in this repository at `deploy/a2a/kafka/docker-compose.yml`.
