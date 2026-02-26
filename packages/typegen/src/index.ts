export type ToolMap = Record<string, { input: unknown; output: unknown }>;

export type MeshClientInstance<T extends ToolMap> = {
  [K in keyof T]: (input: T[K]["input"]) => Promise<T[K]["output"]>;
};

export type MeshClient<T extends ToolMap> = MeshClientInstance<T> & {
  /** Close the underlying MCP connection and reset it so the next call reconnects. */
  close(): Promise<void>;
};

export interface MeshClientOptions {
  mcpId: string;
  /** Falls back to process.env.MESH_API_KEY */
  apiKey?: string;
  /** Falls back to https://mesh-admin.decocms.com */
  baseUrl?: string;
}

export { createMeshClient } from "./runtime.js";
