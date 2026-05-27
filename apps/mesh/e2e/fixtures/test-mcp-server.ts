/**
 * In-process MCP server for Playwright tests.
 *
 * Spins up a tiny HTTP MCP server on a random port using `node:http` (NOT
 * `Bun.serve` — Playwright runs specs under Node, not Bun) so a test can
 * create a real mesh connection that points at something real but
 * controlled. Uses the SDK's `StreamableHTTPServerTransport` (Node
 * wrapper around the same Web-Standard transport mesh uses internally),
 * so the wire protocol matches production exactly.
 *
 * Why not Docker (like tests/resilience/everything-server)? Per-test
 * lifecycle, parallel workers, zero startup overhead. Each test stands
 * up its own server, configures it, and tears it down inline.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

/**
 * Read the request body as a UTF-8 string. The SDK transport accepts a
 * pre-parsed body via `handleRequest(req, res, parsedBody)`, which avoids
 * the SDK having to re-buffer the IncomingMessage we already consumed.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startTestMcpServer(
  config: TestMcpServerConfig = {},
): Promise<TestMcpServer> {
  const tools = config.tools ?? DEFAULT_TOOLS;
  let failNext = config.failNext ?? 0;
  const latencyMs = config.latencyMs ?? 0;
  const recorded: RecordedRequest[] = [];

  // Build a fresh server per request — the streamable transport is designed
  // to be one-shot in stateless mode, mirroring how mesh's /mcp/self mounts
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

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (latencyMs > 0) {
          await new Promise((r) => setTimeout(r, latencyMs));
        }

        let parsedBody: unknown = undefined;
        if (req.method === "POST") {
          const raw = await readBody(req);
          try {
            parsedBody = JSON.parse(raw);
            if (
              parsedBody &&
              typeof parsedBody === "object" &&
              "method" in parsedBody
            ) {
              recorded.push({
                method: String((parsedBody as { method: unknown }).method),
                body: parsedBody,
                timestamp: Date.now(),
              });
            }
          } catch {
            // not JSON; pass through as undefined so transport reads raw
          }
        }

        if (failNext > 0) {
          failNext--;
          res.statusCode = 500;
          res.end("test-mcp-server: injected failure");
          return;
        }

        const server = buildServer();
        // Stateless mode so each request stands alone — matches mesh's
        // per-request server pattern in self.ts.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse:
            req.headers.accept?.includes("application/json") ?? false,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(`test-mcp-server: ${(err as Error).message}`);
        } else {
          res.end();
        }
      }
    },
  );

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const port = (httpServer.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/`,
    requests: recorded,
    setFailNext: (n) => {
      failNext = n;
    },
    stop: async () => {
      // `close()` alone waits for in-flight connections to drain, which
      // the MCP transport keeps alive (intended for SSE streams). Force
      // them shut so the test's afterAll doesn't time out at 30s.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
