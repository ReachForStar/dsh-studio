---
description: "Expose OpenAPI 3.x operations as model-visible tools, with authentication kept host-side."
kind: "package-reference"
---

# @deepseek-ai/dsh-openapi-tools

English | [中文](README.zh.md)

## Summary

Turn one OpenAPI 3.x document into tools the model can call directly. At activation the plugin reads a local file or URL, converts every representable operation into a tool on `ctx.tools`, merges path, query, header, and JSON request-body parameters into one schema, and executes calls over `fetch`. Authentication stays host-side: the document's security schemes never reach the model, and one configured credential is attached to each request. Operations the value-schema DSL cannot express are skipped and logged with a reason instead of shipping a partial tool.

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

Mount one document per plugin instance:

```yaml
- id: openapi-tools
  name: '@deepseek-ai/dsh-openapi-tools'
  config:
    spec: ./openapi/petstore.yaml
    baseUrl: https://api.example.com/v1
    headers:
      x-client: dsh
    auth:
      credential: ${credential:PET_API_TOKEN}
      scheme: bearer
```

`spec` is a local path or an absolute HTTP(S) URL, and activation fails with `OPENAPI_SPEC_LOAD` or `OPENAPI_SPEC_INVALID` when the document cannot be read, parsed, or is not OpenAPI 3.x. `baseUrl` overrides every `servers` entry; without it the first absolute server URL of the operation, path item, or document is used.

`headers` are sent on every request. `auth.credential` accepts a `${credential:NAME}` reference resolved through `ctx.credentials` or a bare environment-variable name; `scheme` is `bearer` (default), `header`, or `query`, and the last two require `name`. A resolved secret is read per request, so a rotated value applies to the next call without restarting the plugin. When the credential is unavailable the call fails instead of sending an anonymous request.

Limits default to `timeoutMs: 30000`, `maxResponseChars: 20000`, `maxErrorBodyChars: 1000`, and `descriptionMaxLength: 1024`; each must be a positive integer.

### Naming and skipping

- The tool name comes from `operationId`, sanitized to `[A-Za-z0-9_-]` and capped at 64 characters; a missing `operationId` yields a name such as `deletePetsByPetId`.
- A duplicate name gets a stable numeric suffix (`listPets_2`).
- Same-named path, query, header, and body parameters are qualified by location (`query_value`, `header_value`).
- Every skipped operation is logged through `ctx.logger.warn` with its method, path, and reason. `webhooks` entries are logged too.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/document.ts` holds document predicates and local `$ref` resolution. `src/schema.ts` converts OpenAPI schema nodes into the `dsh-tools` value-schema DSL and raises `UnsupportedSchemaError` for `allOf`, `anyOf`, `not`, external references, tuples, and non-JSON constructs. `src/spec.ts` loads the document and plans each operation: name, description, merged parameters, serialization style, body media type, and skip reasons. `src/runtime.ts` builds the URL, serializes each argument, attaches static headers and the host credential, and normalizes the response.

Supported request constructs:

| Construct | Support |
| --- | --- |
| `path`, `query`, `header` parameters | `simple` for path and header; `form` and `deepObject` for query |
| Required parameters | Path parameters are always required |
| JSON request body | `application/json` and `*+json`, one `body` argument |
| Schema keywords | `type`, `items`, `properties`, `required`, `additionalProperties` (as an open/closed switch), `enum`, `const`, `nullable`, `readOnly` filtering, local `$ref` |
| Composition | `oneOf`; recursive local `$ref` degrades to raw JSON |

Ignored but accepted: `description`, `summary`, `format`, `default`, `example`, `deprecated`, and OpenAPI security declarations. Unsupported request constructs skip the whole operation: `cookie` parameters, `allowReserved`, `spaceDelimited`/`pipeDelimited` styles, `multipart/form-data`, `application/x-www-form-urlencoded`, any non-JSON body, `allOf`/`anyOf`/`not`, external `$ref`, tuple `items`/`prefixItems`, operations declaring `callbacks`, and document `webhooks`.

At execution the response is parsed as JSON when its content type is `application/json` or `*+json`; malformed JSON fails with `OPENAPI_RESPONSE_INVALID`. Other content types return up to `maxResponseChars` characters. A non-2xx status fails with `OPENAPI_HTTP_ERROR` naming the status and up to `maxErrorBodyChars` characters of the body. Transport failures fail with `OPENAPI_REQUEST_FAILED`; caller cancellation stays an abort.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-tools`](../../core/tools/README.md) — tool definitions, the parameter schema DSL, and registration.
- [`dsh-credentials`](../../credentials/credentials/README.md) — the credential-reference seam this plugin resolves through.
- [OpenAPI Specification 3.1](https://spec.openapis.org/oas/v3.1.0) — the document constructs above.

<a id="model-experience"></a>
## Model Experience

### Generated operation tools

#### What the model sees

One tool per representable operation. The name is the sanitized `operationId` or a method-and-path fallback. The description starts with `METHOD /path` and then the operation `summary` (or `description`), collapsed to one paragraph and truncated to `descriptionMaxLength`. The parameter schema contains merged path, query, and header parameters plus one optional or required `body` object for a JSON request body; parameter descriptions and `enum` constraints are preserved. No authentication header, query key, or security declaration appears in the schema.

#### Token effect

Every registered operation adds its description and parameter schema to each request for the whole Session. Cost grows with the operation count and the size of each converted schema; `descriptionMaxLength` caps only the description.

#### KV Cache effect

The registered tool schemas are part of the request prefix. They stay byte-identical while the document, `baseUrl`, and the package configuration are unchanged. Editing the document, changing `descriptionMaxLength`, or changing another plugin's tool names replaces the prefix and invalidates reuse from the change onward.

### Operation results

#### What the model sees

A JSON response reaches the model as its serialized JSON text; a non-JSON response is returned as text truncated to `maxResponseChars`, and an empty body becomes `null`. A failure is one sentence: `openapi-tools: METHOD /path failed with HTTP <status>: <truncated body>`.

#### Token effect

One result per call, capped at `maxResponseChars` characters of rendered text. JSON values are rendered whole, so a large JSON response can exceed that cap.

#### KV Cache effect

Results append after the request prefix and never replace earlier tokens; a result does not invalidate reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only JSON request bodies are supported. `multipart/form-data`, `application/x-www-form-urlencoded`, binary uploads, and CSV or XML bodies skip the whole operation.
- `allOf`, `anyOf`, `not`, external `$ref`, and tuple items skip the operation. A recursive local `$ref` is exposed as raw JSON instead of its declared structure.
- OpenAPI security schemes are not interpreted. One host-side credential applies to every operation of the mounted document, so a document whose operations need different credentials requires separate plugin instances.
- Cookie authentication, callbacks, webhooks, SSE, and binary responses are unsupported; a `2xx` response schema never shapes the tool output, which is declared as raw JSON.
- The whole response body is buffered before parsing, and only the emitted text is capped; a very large JSON body can consume memory and model context.
- Parameter `default`, `format`, `pattern`, and numeric bounds are not projected into the schema, so the model learns them only from the description or a failed request.
- One plugin instance mounts one document. Two documents that declare the same `operationId` collide in `ctx.tools`; rename the operations or mount them under different agents.

<a id="dev-note"></a>
### Dev Note

The package exists to expose an existing HTTP API without hand-writing a tool per endpoint. Planning is a pure function over the parsed document so every skip reason is testable without a network; the runtime tests drive a real local HTTP server for success, failure, and non-JSON replies.
