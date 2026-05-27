/**
 * In-process MCP server for Playwright tests.
 *
 * Spins up a tiny HTTP MCP server on a random port using `Bun.serve` so a
 * test can create a real mesh connection that points at something real but
 * controlled. The fixture re-uses mesh's transport
 * (`WebStandardStreamableHTTPServerTransport`) so the wire protocol matches
 * production exactly — no hand-rolled JSON-RPC framing.
 *
 * Why not Docker (like tests/resilience/everything-server)? Per-test
 * lifecycle + parallel workers + zero startup overhead. Each test stands
 * up its own server, configures it, and tears it down inline.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

type ToolHandler = (
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface TestMcpTool {
  name: string;
  description?: string;
  /**
   * Zod *raw shape* (e.g. `{ message: z.string() }`) — matches McpServer's
   * `registerTool` signature. Defaults to `{}` (no args).
   */
  inputSchema?: Record<string, z.ZodTypeAny>;
  /**
   * Whatever this returns is wrapped into a `content: [{type: "text", text}]`
   * MCP response. If omitted, the tool returns `{ ok: true }`.
   */
  handler?: ToolHandler;
}

export interface TestMcpServerConfig {
  /** Tools exposed by the server. Defaults to a single `echo` tool. */
  tools?: TestMcpTool[];
  /**
   * If > 0, the server returns 500 for the next N requests, then resumes
   * normal handling. Useful for circuit-breaker / retry tests.
   */
  failNext?: number;
  /** Sleep this many ms before responding. Useful for timeout tests. */
  latencyMs?: number;
}

export interface RecordedRequest {
  method: string;
  body: unknown;
  timestamp: number;
}

export interface TestMcpServer {
  /** Base URL ending in `/`. Pass this as the connection URL in mesh. */
  url: string;
  /** Every JSON-RPC request the server saw, in arrival order. */
  requests: ReadonlyArray<RecordedRequest>;
  /** Set/reset the failure injection count at runtime. */
  setFailNext: (n: number) => void;
  /** Stop the server. Always `await` this in `test.afterAll` or similar. */
  stop: () => Promise<void>;
}

const DEFAULT_TOOLS: TestMcpTool[] = [
  {
    name: "echo",
    description: "Returns the input message verbatim.",
    inputSchema: { message: z.string() },
    handler: (args) => ({ echoed: String(args.message ?? "") }),
  },
];

export async function startTestMcpServer(
  config: TestMcpServerConfig = {},
): Promise<TestMcpServer> {
  const tools = config.tools ?? DEFAULT_TOOLS;
  let failNext = config.failNext ?? 0;
  const latencyMs = config.latencyMs ?? 0;
  const recorded: RecordedRequest[] = [];

  // Build a fresh server per request — the streamable transport is designed
  // to be one-shot in JSON mode, mirroring how mesh's own /mcp/self mounts
  // (see apps/mesh/src/api/routes/self.ts).
  const buildServer = (): McpServer => {
    const server = new McpServer({ name: "test-mcp", version: "1.0.0" });
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema ?? {},
        },
        async (args: Record<string, unknown>) => {
          const result = tool.handler ? await tool.handler(args) : { ok: true };
          return {
            content: [
              {
                type: "text" as const,
                text:
                  typeof result === "string" ? result : JSON.stringify(result),
              },
            ],
          };
        },
      );
    }
    return server;
  };

  const httpServer = Bun.serve({
    port: 0, // OS picks an unused port
    fetch: async (req) => {
      if (latencyMs > 0) {
        await new Promise((r) => setTimeout(r, latencyMs));
      }

      // Capture the JSON-RPC method name + body for later assertions, but
      // don't fail the request if the body isn't JSON (e.g., a GET).
      if (req.method === "POST") {
        try {
          const body = await req.clone().json();
          if (body && typeof body === "object" && "method" in body) {
            recorded.push({
              method: String((body as { method: unknown }).method),
              body,
              timestamp: Date.now(),
            });
          }
        } catch {
          // not JSON; skip logging
        }
      }

      if (failNext > 0) {
        failNext--;
        return new Response("test-mcp-server: injected failure", {
          status: 500,
        });
      }

      const server = buildServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse:
          req.headers.get("Accept")?.includes("application/json") ?? false,
      });
      await server.connect(transport);
      return transport.handleRequest(req);
    },
  });

  const host =
    httpServer.hostname === "::" || httpServer.hostname === "0.0.0.0"
      ? "127.0.0.1"
      : httpServer.hostname;

  return {
    url: `http://${host}:${httpServer.port}/`,
    requests: recorded,
    setFailNext: (n) => {
      failNext = n;
    },
    stop: async () => {
      httpServer.stop();
    },
  };
}
