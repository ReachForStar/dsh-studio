---
description: "Markdown prompt templates that expand into user messages through slash commands."
kind: "package-reference"
---

# @deepseek-ai/dsh-prompt-templates

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-prompt-templates` to turn Markdown files into reusable `/` commands. Each template file in a configured directory becomes a command named after its file; running `/name arguments` expands the template body and injects the result as one user message through the ordinary session path. The template command itself produces no model message, so the expanded text is the only new conversation input. Mount it when users should reuse prompt text without writing a plugin.

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

Mount the plugin in a composition that provides the command registry, then list template directories. Only direct `.md` children are loaded.

```yaml
- name: '@deepseek-ai/dsh-prompt-templates'
  config:
    directories:
      - /path/to/prompts
```

A template file starts with YAML frontmatter and continues with the body:

```markdown
---
description: Review staged changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness, security, and error handling}.
```

The filename becomes the command name, so the file above is `/review`. The `description` appears in command discovery and `argument-hint` in the composer. A file without a description, or with an empty body, is ignored.

### Argument substitution

Arguments follow shell-like quoting: a quote starts quoting only at the beginning of an argument, and a backslash before the same quote keeps it literal.

| Syntax | Result |
|---|---|
| `$1`, `$2`, … | One positional argument |
| `$@` or `$ARGUMENTS` | All arguments joined with spaces |
| `${1:-default}` | One argument, or a default value |
| `${@:-default}` | All arguments, or a default value |
| `${@:N}` | Arguments starting at position `N` |
| `${@:N:L}` | `L` arguments starting at position `N` |

Input that does not name a loaded template stays ordinary prompt text.

<a id="understand-the-implementation"></a>
## Understand the implementation

At load, the plugin scans every configured directory, parses each `.md` file's YAML frontmatter and body, and registers one command per valid template. Registering a name that already exists logs a warning and keeps the earlier command, so a template never shadows an existing command silently.

The command handler parses the invocation's free-form input, expands the body, and appends the result as one user message through the agent's ordinary follow-up path. The message source names the template, so a reader can tell an expanded prompt from typed text. The command's own lifecycle events record only the invocation and its settled result.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-commands`](../commands/README.md) — the command registry and execution lifecycle.
- [`dsh-skill`](../../skill/skill/README.md) — on-demand instructions loaded by the model, a different reuse mechanism.

<a id="model-experience"></a>
## Model Experience

### Prompt template expansion

#### What the model sees

The expanded template text, as one user message in the ordinary conversation. The model sees no frontmatter, no template name, and no command metadata. Input that does not match a loaded template reaches the model unchanged.

#### Token effect

A matched template replaces the typed command line with the expanded body, so the request carries the expanded text instead of the raw `/name arguments` line. No additional prompt sections or tool schemas are added.

#### KV Cache effect

None beyond the ordinary user message: the expanded text changes the conversation prefix exactly as typed text would, with no separate cache key.

## Known Limitations and Deferred Work

- Templates are loaded at plugin load; adding or changing a file needs a reload or restart.
- Only direct `.md` children are discovered; nested directories and glob filters are not supported.
- A template name that is not a lowercase command name is skipped with a warning.
- Templates are not project-trust gated; the configured directories are trusted configuration.

<a id="dev-note"></a>
### Dev Note

The expansion is a presentation-to-message bridge: the command exists only to name a template, and the injected message keeps the ordinary session path so model-visible input stays reconstructable from the log.
