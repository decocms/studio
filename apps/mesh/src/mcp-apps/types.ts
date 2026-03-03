export type {
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiDisplayMode,
  McpUiInitializeResult,
  McpUiResourceMeta,
  McpUiHostStyles,
  McpUiTheme,
} from "@modelcontextprotocol/ext-apps";

import type { McpUiResourceCsp as _McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";

/**
 * Extended CSP type that adds `wasmEval` on top of the upstream
 * `McpUiResourceCsp`. When the upstream spec adds this field we can
 * drop the extension and re-export directly.
 */
export interface McpUiResourceCsp extends _McpUiResourceCsp {
  /**
   * When `true`, adds `'unsafe-eval'` to the `script-src` directive,
   * allowing `eval()` / `new Function()` inside the sandboxed iframe.
   *
   * Required by libraries that use runtime code generation (e.g. CesiumJS's
   * knockout.js bindings).
   */
  unsafeEval?: boolean;

  /**
   * When `true`, adds `'wasm-unsafe-eval'` to the `script-src` directive,
   * allowing WebAssembly compilation inside the sandboxed iframe.
   *
   * Required by libraries like CesiumJS that use `WebAssembly.instantiate()`.
   */
  wasmEval?: boolean;
}

export { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps";

import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";

export const MCP_APP_DISPLAY_MODES = {
  collapsed: { minHeight: 150, maxHeight: 300 },
  expanded: { minHeight: 300, maxHeight: 600 },
  view: { minHeight: 400, maxHeight: 800 },
  fullscreen: { minHeight: 600, maxHeight: 1200 },
} as const;

export type MCPAppDisplayModeKey = keyof typeof MCP_APP_DISPLAY_MODES;

const UI_RESOURCE_URI_SCHEME = "ui://";

export interface ToolMetaWithUI {
  [key: string]: unknown;
}

export function getUIResourceUri(meta: unknown): string | undefined {
  if (meta == null || typeof meta !== "object") return undefined;
  try {
    return getToolUiResourceUri({ _meta: meta as Record<string, unknown> });
  } catch {
    return undefined;
  }
}

export function isUIResourceUri(uri: string): boolean {
  return uri.startsWith(UI_RESOURCE_URI_SCHEME);
}
