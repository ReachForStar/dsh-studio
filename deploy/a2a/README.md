# Local A2A stack

English | [中文](README.zh.md)

One command brings up the local review/bug/planning stack: the Kafka cluster the A2A bus runs on, the three A2A gateways that host the specialist seats, and the Web app. **`up` starts only what is not already running** — containers reported `running` are skipped, a gateway is skipped while its port answers, and the Web app is skipped while its port answers.

```sh
pnpm run stack:up       # Kafka (skip if up) → three gateways → Web app
pnpm run stack:status   # report each component; changes nothing
pnpm run stack:down     # stop gateways and Web app started by stack:up
pnpm run stack:down --kafka      # also stop the Kafka cluster
```

`stack:up` waits up to 30 seconds for every port to answer and prints the final state. Logs land in `tmp/a2a-stack/`: one per gateway, `web.log` for the Web app. The token the Web app prints on startup is in `tmp/a2a-stack/web.log`.

## Components

| Component | Port | Source |
| --- | --- | --- |
| Kafka 3-broker KRaft cluster | 9092 / 9093 / 9094 | `kafka/docker-compose.yml` (this repository) |
| pi gateway | 9310 | gateway checkout (`A2A_BRIDGE_DIR`) |
| Claude Code gateway | 9320 | gateway checkout (`A2A_BRIDGE_DIR`) |
| opencode gateway | 9330 | gateway checkout (`A2A_BRIDGE_DIR`) |
| Web app | 3080 | `apps/cli/lib/bin.js` (this repository) |

## Configuration

`a2a.config.json` is the bridge configuration: ports, bus topics, models, and the OpenCode skill-to-agent mapping. `stack:up` exports it as `A2A_CONFIG` to the gateways and to the Web app, so both sides of a dispatch read one file. The Web profile patch resolves `a2a.bridge.configPath` from the same variable, and its fallback points at the gateway checkout.

Environment overrides:

| Variable | Meaning | Default |
| --- | --- | --- |
| `A2A_BRIDGE_DIR` | gateway checkout providing `packages/*/dist/index.js` | `D:/file/a2a-bridge` |
| `A2A_CONFIG` | bridge configuration path | `deploy/a2a/a2a.config.json` (set by the launcher) |
| `A2A_BUS_BOOTSTRAP` | Kafka bootstrap servers used by the gateways | value from the configuration |
| `A2A_API_KEY` | bearer token for the gateway HTTP endpoints | empty (loopback only) |

The compose file pins `name: kafka`, so the cluster keeps one Docker Compose project no matter which directory the file is invoked from; `stack:up` therefore sees the containers started from an earlier checkout as the same cluster.

## Requirements

- Docker reachable either directly or through WSL; the launcher probes both and uses whichever answers.
- A built gateway checkout: `npm run build` in `A2A_BRIDGE_DIR` produces the `dist/` entries `stack:up` starts. Without them the launcher reports the missing path and skips that gateway.
- A built Web app: `pnpm run build` produces `apps/cli/lib/bin.js`.

## Troubleshooting

- **A gateway does not answer after 30 seconds** — read `tmp/a2a-stack/gw-<name>.log`; a missing model key or an unbuilt checkout is reported there.
- **Commands stay in `WORKING`** — the seat is running remotely; the gateway log carries the model and per-task output.
- **Ports stay occupied after `stack:down`** — those processes were started outside the stack; the report lists the ports it refused to claim.
