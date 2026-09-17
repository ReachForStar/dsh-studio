# Agent Note: Runtime endpoint catalogs

Status: implemented

English | [中文](2026-09-17-runtime-endpoint-catalogs.zh.md)

## Problem

A provider pi-ai ships no models for — the AMAX Token Router gateway, an account-scoped or self-hosted endpoint — had to list every model in configuration before any request could resolve one. The configuration surface could already read such an endpoint's `GET /models` listing, but that reading only ever produced metadata for a human to save: `resolveRouteModels` refused a route with no installed catalog and no `models` list, so a route whose models exist only at the endpoint could not serve a request at all. The failure was a configuration error naming the wrong remedy — "list the models" — for a gateway whose models nobody can enumerate ahead of time.

## Decision

A route with no configured `models` list, no installed catalog, and a readable endpoint protocol (`openai-completions`, `openai-responses`, `anthropic-messages`) resolves as an endpoint-served route. `resolveProfiles` records that reading on the profile (`endpointCatalog`), resolves such a route with deferred validation even for a settings write, and leaves its catalog empty until the request path performs the reading. The protocol defaults to `openai-completions` when neither the route nor the catalog card names one, and the endpoint defaults to the catalog card's `baseUrl` — the same two assumptions the configuration surface's fetch action already made.

`PiAiAdapter` performs the reading once per generation — its per-configuration cache, keyed on the profile map's identity — and only for the route an operation names, so an unrelated unreachable gateway never delays a request. The reading reuses the route's own resolution facts and materialises through `resolveRouteModels` unchanged, which is what makes an endpoint-served model resolve exactly as a configured one does, including the route's declared defaults and the gateway's compatibility quirks. A failed reading is retained per route and reported by a request on that route with the endpoint's own coded fault (an unreachable URL, a rejected credential, a timeout); `listModels` returns no models rather than throwing, because an unreadable catalog serves nothing. The route's `timeoutMs` bounds the reading when configured.

## Alternatives considered

**Write the discovered listing into `settings.yaml` at configuration time.** This makes the endpoint's answer durable and visible, but it makes the harness own a copy that silently goes stale, requires a settings write from a read-only inspection, and contradicts `settings.yaml` being the only thing that decides what a route serves.

**Read every endpoint-served route before every operation.** Simpler than per-generation caching, but it puts a network round trip in front of every request and lets one broken gateway delay requests for every other route.

**Cache the reading process-wide instead of per configuration.** Cheaper, but a deployment that edits a route's endpoint or key would keep serving the old endpoint's models until restart; keying on the configuration keeps the reading as fresh as the configuration it came from.

**Resolve an endpoint-served route with an empty catalog and report `UNKNOWN_MODEL`.** This drops the diagnostic that actually explains the failure and leaves the operator repairing the model id rather than the endpoint.

## Consequences

The request path can now perform network I/O before its first model call, on the first operation that needs an endpoint-served route; every later operation in the same configuration reuses the reading. A model the endpoint starts serving is not visible until the configuration changes or the process restarts, and a route that lists a single bad model keeps the whole route unread, because the configuration already enumerated its catalog. `llm-pi-ai` package tests cover eligibility, the reading's materialisation, per-generation reuse, configuration-change re-reading, both failure forms, the route's timeout bound, and a full listing-plus-completion request against a local endpoint.
