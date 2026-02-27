export type {
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiDisplayMode,
  McpUiInitializeResult,
  McpUiResourceMeta,
  McpUiResourceCsp,
  McpUiHostStyles,
  McpUiTheme,
} from "@modelcontextprotocol/ext-apps";

export {
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
} from "@modelcontextprotocol/ext-apps";

import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";

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

export function hasUIResource(meta: unknown): meta is ToolMetaWithUI {
  if (meta == null || typeof meta !== "object") return false;
  const obj = meta as Record<string, unknown>;
  return typeof obj[RESOURCE_URI_META_KEY] === "string";
}

export function getUIResourceUri(meta: unknown): string | undefined {
  if (!hasUIResource(meta)) return undefined;
  return (meta as Record<string, unknown>)[RESOURCE_URI_META_KEY] as string;
}

export function isUIResourceUri(uri: string): boolean {
  return uri.startsWith(UI_RESOURCE_URI_SCHEME);
}
