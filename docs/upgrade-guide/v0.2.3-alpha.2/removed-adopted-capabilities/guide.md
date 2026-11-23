---
kind: upgrade-guide
description: "Twenty-one packages adopted from qwen-code, pi, opencode, codex, and ZCode are removed, together with their profile rows, tools, commands, and configuration keys."
---
# Capabilities adopted from external harnesses are removed

English | [中文](guide.zh.md)

## Change

The packages added for the qwen-code, pi, opencode, and codex/ZCode capability programs are gone. A profile or `cordis.yml` that still names any of them fails to load.

Removed package names: `dsh-agent-plugins`, `dsh-tool-search`, `dsh-arena`, `dsh-memory-notes`, `dsh-step-summary`, `dsh-followup`, `dsh-speculation` (and `dsh-speculation/runner`, `/overlay`), `dsh-codemode`, `dsh-agent-virtual-model`, `dsh-git-checkpoint`, `dsh-handoff`, `dsh-prompt-templates`, `dsh-input-handled`, `dsh-command-label`, `dsh-warming`, `dsh-fork-notice`, `dsh-openapi-tools`, `dsh-test-support-http-cassette`, `dsh-client-ui-markdown-mermaid`, `dsh-btw`, and `dsh-webhook`'s message action.

Removed model-facing tools: `tool_search`, `watch_mcp_resource`, `memory_write`, and codemode's `run_code`. Removed commands: `/handoff`, `/checkpoint`, `/label`, `/btw`, `/full-access`, `/correct`, and `/allow`. The default Web preset no longer enables `apply_patch`.

Removed `mcp-client` keys: `resourceWatchTimeoutMs` and `maxResourceWatchTimeoutMs`. Approval rules (`rules`, `match`, project allowlists, always-allow) are gone, so `approval/policy` accepts only `ask` and `never` again.

Sessions recorded earlier remain readable: the event types and message attributions they contain stay declared.

## Migration

1. Delete every removed package name from profile patches, `cordis.yml` files, and bundle lists. `pnpm dsh doctor` reports unknown plugins before startup.
2. Drop the removed `mcp-client` keys and any `toolSearch`, `sdkBudgetTokens`, or speculation settings from your configuration.
3. Replace `tool_search` and `memory_write` usage in prompts or skills with ordinary tool calls; replace `watch_mcp_resource` with `read_mcp_resource` polling.
4. Add `apply_patch` to your preset explicitly if you relied on it being enabled by default.
5. Start the profile you normally use and confirm the harness boots and a conversation runs one turn.
