/**
 * MCP servers settings surface, node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half owns the tab through
 * exports["./client"], discovered from the package.json dsh.client declaration.
 * Server state and every action belong to `dsh-mcp-manager` on the Host.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
