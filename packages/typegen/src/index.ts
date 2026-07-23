export type ToolMap = Record<string, { input: unknown; output: unknown }>;

export type StudioClientInstance<T extends ToolMap> = {
  [K in keyof T]: (input: T[K]["input"]) => Promise<T[K]["output"]>;
};

export type StudioClient<T extends ToolMap> = StudioClientInstance<T> & {
  /** Close the underlying MCP connection and reset it so the next call reconnects. */
  close(): Promise<void>;
};

export interface StudioClientOptions {
  /** Virtual MCP id. Optional when an endpoint is passed or discoverable. */
  mcpId?: string;
  /** Falls back to process.env.STUDIO_API_KEY (or legacy process.env.MESH_API_KEY) */
  apiKey?: string;
  /** Falls back to https://studio.decocms.com */
  baseUrl?: string;
  /**
   * A full pre-authenticated endpoint — overrides mcpId/apiKey/baseUrl.
   * When omitted and no api key resolves, the sandbox endpoint file
   * (`.deco/tools/.endpoint.json`, written by the daemon) is discovered by
   * walking up from cwd, so scripts inside a sandbox connect with no config.
   */
  endpoint?: { url: string; headers?: Record<string, string> };
}

/** @deprecated Use `StudioClientInstance`. */
export type MeshClientInstance<T extends ToolMap> = StudioClientInstance<T>;
/** @deprecated Use `StudioClient`. */
export type MeshClient<T extends ToolMap> = StudioClient<T>;
/** @deprecated Use `StudioClientOptions`. */
export type MeshClientOptions = StudioClientOptions;

export { discoverEndpoint, type DiscoveredEndpoint } from "./endpoint.js";
export { createMeshClient, createStudioClient } from "./runtime.js";
