import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  StreamableHTTPClientTransport as BaseStreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Client-side HTTP transport for MCP connections.
 * Extends StreamableHTTPClientTransport with support for mocking certain MCP protocol messages.
 */
export class StreamableHTTPClientTransport extends BaseStreamableHTTPClientTransport {
  constructor(url: URL, opts?: StreamableHTTPClientTransportOptions) {
    super(url, opts);
  }

  override send(
    message: JSONRPCMessage,
    options?: {
      resumptionToken?: string;
      onresumptiontoken?: (token: string) => void;
    },
  ): Promise<void> {
    const mockAction = getMockActionFor(message);
    if (mockAction?.type === "emit") {
      this.onmessage?.(mockAction.message);
      return Promise.resolve();
    }
    if (mockAction?.type === "suppress") {
      return Promise.resolve();
    }
    return super.send(message, options);
  }
}

type MockAction =
  | { type: "emit"; message: JSONRPCMessage }
  | { type: "suppress" };

function getMockActionFor(message: JSONRPCMessage): MockAction | null {
  const m = message;
  if (!m || typeof m !== "object" || !("method" in m)) return null;

  switch (m.method) {
    case "initialize": {
      const protocolVersion = m?.params?.protocolVersion;
      if (!protocolVersion) return null;
      return {
        type: "emit",
        message: {
          result: {
            protocolVersion,
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
              tasks: {
                list: {},
                cancel: {},
                requests: { tool: { call: {} } },
              },
            },
            serverInfo: { name: "studio-virtual-mcp", version: "1.0.0" },
          },
          jsonrpc: m.jsonrpc ?? "2.0",
          // @ts-expect-error - id is not typed
          id: m.id,
        } as JSONRPCMessage,
      };
    }
    case "notifications/roots/list_changed":
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/progress": {
      return { type: "suppress" };
    }
    default:
      return null;
  }
}
