/**
 * Stdio Client Transport
 *
 * Creates a stdio-based MCP client connection.
 *
 * @see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/stdio.ts
 */

import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";

export interface StableStdioConfig extends StdioServerParameters {
  /** Unique ID for this connection (for logging) */
  id: string;
  /** Human-readable name for the MCP (for logging) */
  name?: string;
}

/**
 * Create a stdio transport with stderr logging hooked up
 */
export function createStdioTransport(
  config: StableStdioConfig,
): StdioClientTransport {
  // Create transport - SDK handles spawning and merges env with getDefaultEnvironment()
  // We only pass the additional env vars we need (like API tokens)
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    stderr: "pipe", // Capture stderr for debugging
  });

  // Handle stderr for debugging - pass through MCP logs with subtle connection reference
  const label = config.name || config.id;
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  transport.stderr?.on("data", (data: Buffer) => {
    const output = data.toString().trimEnd();
    if (output) {
      // Print MCP output first, then subtle connection reference
      console.error(`${output} ${dim}[${label}]${reset}`);
    }
  });

  return transport;
}
