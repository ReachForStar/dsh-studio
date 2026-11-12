/**
 * Chat Markdown Mermaid plugin, node half. Pure UI plugin: the empty apply
 * exists so the plugin appears in the host cordis.yml / Loader; the browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration.
 */

/** Host plugin body — this package renders fences only in the browser. */
export function apply(): void {}
