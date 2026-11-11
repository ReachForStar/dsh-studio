---
description: "Model-facing tool discovery: search the session tool surface by keyword or fetch one tool by name."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-search

English | [中文](README.zh.md)

## Summary

Give the model a way to find tools whose schemas are not in view. `tool_search` searches the calling agent's visible tools by keyword, or fetches one by exact name, and answers with each match's name, description, and parameter schema; the model then calls that tool directly through the normal executor. The package registers one tool and adds no policy, no restrictions, and no session events.

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

Mount it on a composition whose tool surface is larger than the schemas worth keeping in every request: with deferred tool loading, the model sees a short catalog and calls `tool_search` before it needs a tool it has not seen.

```yaml
- id: tool-search
  name: '@deepseek-ai/dsh-tool-search'
  config:
    maxResults: 8
    descriptionMaxLength: 240
```

`maxResults` caps one search (minimum 1, default 8); `descriptionMaxLength` caps each returned description (minimum 40, default 240). Both are validated when the plugin loads and a value out of range fails activation.

### Query behavior

- `name` returns that exact tool when it is visible to the agent, and wins over `query`.
- `query` splits on whitespace; every term must appear in the tool name or description.
- Tools whose name matches a term rank before tools that only match in the description.
- Without either argument the call returns an empty catalog and its presentation explains how to search.

<a id="understand-the-implementation"></a>
## Understand the implementation

Visibility comes from `ctx.tools.definitions(agent)`: the search reads the same layered registry the executor resolves, so a restriction or a scoped shadow changes the search result exactly as it changes the callable set.

## Further Exploration

- [`dsh-tools`](../../core/tools/README.md) — registry, visibility, and execution
- [`dsh-llm`](../../llm/llm/README.md) — deferred tool loading

<a id="model-experience"></a>
## Model Experience

### Search results

#### What the model sees

One result block per match: a `## <name>` heading, the tool description, and the parameter schema as a JSON code fence. An empty search returns a single sentence naming the two search forms.

#### Token effect

Each search costs one tool result; schemas are counted only for the tools a call returned, capped by `maxResults`.

#### KV Cache effect

The tool schema is part of the request prefix. Results append after it, so a search never rewrites what earlier requests already cached.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The tool returns schemas; it does not call the matched tool, and it does not decide when deferred loading should hand a tool back to the immediate surface.
- Matching is substring-based. Semantic search over tool descriptions is out of scope.
- Results are capped by count only; one very large schema can still dominate a result.

<a id="dev-note"></a>
### Dev Note

The package exists because deferred tool loading leaves the model a catalog without schemas: without a search surface the model can only guess names. Coverage stays at 100% per file.
