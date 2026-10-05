import * as endpoint from "@decocms/studio-cli/endpoint";

// Declared here rather than re-exported so the published typings stand alone:
// `@decocms/studio-cli` is a private workspace package bundled into dist.

export interface DiscoveredEndpoint {
  url: string;
  headers?: Record<string, string>;
  /** Epoch ms when the endpoint's credential expires. */
  expiresAt?: number;
}

export const discoverEndpoint: (
  startDir?: string,
) => DiscoveredEndpoint | null = endpoint.discoverEndpoint;

export const withMcpId: (url: string, mcpId: string) => string =
  endpoint.withMcpId;

export const mcpIdFromUrl: (url: string) => string | undefined =
  endpoint.mcpIdFromUrl;
