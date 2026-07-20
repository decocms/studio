import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

/**
 * The sandbox daemon materializes the run's pre-authenticated Virtual MCP
 * endpoint at `<repo>/.deco/tools/.endpoint.json` (next to the tool catalog).
 * Discovering it is what lets the CLI and the generated client run flagless
 * inside a sandbox — and since it's re-read on every connect, a daemon
 * rewrite with refreshed credentials is picked up by simply reconnecting.
 */
const ENDPOINT_RELPATH = [".deco", "tools", ".endpoint.json"];

export interface DiscoveredEndpoint {
  url: string;
  headers?: Record<string, string>;
  /** Epoch ms when the endpoint's credential expires. */
  expiresAt?: number;
}

/**
 * Walk up from `startDir` looking for `.deco/tools/.endpoint.json`. Returns
 * null when not inside a sandbox workspace or the file is malformed. Sync fs
 * is fine here: this runs in the CLI / user scripts, never the daemon.
 */
export function discoverEndpoint(
  startDir: string = process.cwd(),
): DiscoveredEndpoint | null {
  let dir = resolve(startDir);
  while (true) {
    const file = join(dir, ...ENDPOINT_RELPATH);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        if (parsed && typeof parsed.url === "string") {
          return parsed as DiscoveredEndpoint;
        }
      } catch {
        // fall through — a malformed file is the same as no file
      }
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Point a discovered endpoint URL at a different Virtual MCP id, preserving
 * the base (host, path prefix) and credentials. Returns the URL unchanged
 * when it doesn't follow the `/mcp/virtual-mcp/<id>` shape.
 */
export function withMcpId(url: string, mcpId: string): string {
  return url.replace(
    /\/mcp\/virtual-mcp\/[^/?#]+/,
    `/mcp/virtual-mcp/${encodeURIComponent(mcpId)}`,
  );
}

/** Extract the Virtual MCP id from an endpoint URL, if it has one. */
export function mcpIdFromUrl(url: string): string | undefined {
  const match = /\/mcp\/virtual-mcp\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : undefined;
}
