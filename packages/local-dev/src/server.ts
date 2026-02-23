import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LocalFileStorage } from "./storage.ts";
import { registerTools } from "./tools.ts";
import {
  registerBashTool,
  setupSigtermForwarding,
  activeChildren,
} from "./bash.ts";
import { handleWatch } from "./watch.ts";
import { logOp } from "./logger.ts";

// Session TTL: 30 minutes
const SESSION_TTL_MS = 30 * 60 * 1000;

export interface LocalDevServerOptions {
  rootPath: string;
  port?: number;
}

export interface LocalDevServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
  rootPath: string;
}

export function createLocalDevServer(
  options: LocalDevServerOptions,
): LocalDevServer {
  const { rootPath } = options;
  const port = options.port ?? parseInt(process.env.PORT ?? "4201", 10);

  const storage = new LocalFileStorage(rootPath);
  const transports = new Map<
    string,
    { transport: StreamableHTTPServerTransport; lastAccess: number }
  >();

  // Cleanup stale sessions every 5 minutes
  const cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [id, session] of transports) {
        if (now - session.lastAccess > SESSION_TTL_MS) {
          transports.delete(id);
        }
      }
    },
    5 * 60 * 1000,
  );

  // Unref so the interval doesn't prevent process exit
  cleanupInterval.unref();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, mcp-session-id",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // LDV-05: Readiness endpoint
    if (url.pathname === "/_ready") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ready: true, version: "1.0.0", root: rootPath }),
      );
      return;
    }

    // LDV-07: SSE filesystem watch stream
    if (url.pathname === "/watch") {
      handleWatch(req, res, rootPath);
      return;
    }

    // LDV-03: Presigned URL file serving — path traversal protection required
    if (url.pathname.startsWith("/files/")) {
      const key = decodeURIComponent(url.pathname.replace("/files/", ""));
      try {
        const absolutePath = storage.resolvePath(key);
        // resolvePath() already throws if path escapes root
        const stream = createReadStream(absolutePath);
        stream.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(404);
            res.end("Not found");
          }
        });
        stream.pipe(res);
      } catch {
        res.writeHead(403);
        res.end("Forbidden");
      }
      return;
    }

    // MCP StreamableHTTP transport — ALL MCP traffic goes here
    if (url.pathname.startsWith("/mcp")) {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        let session = sessionId ? transports.get(sessionId) : undefined;

        if (!session) {
          const mcpServer = new McpServer({
            name: "local-dev",
            version: "1.0.0",
          });
          registerTools(mcpServer, storage, port);
          registerBashTool(mcpServer, rootPath);

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (newId) => {
              transports.set(newId, { transport, lastAccess: Date.now() });
              logOp("session:init", newId);
            },
          });

          await mcpServer.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }

        session.lastAccess = Date.now();
        await session.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "GET") {
        const session = sessionId ? transports.get(sessionId) : undefined;
        if (session) {
          session.lastAccess = Date.now();
          await session.transport.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No session found" }));
        return;
      }

      if (req.method === "DELETE") {
        const session = sessionId ? transports.get(sessionId) : undefined;
        if (session) {
          await session.transport.handleRequest(req, res);
          transports.delete(sessionId!);
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  let actualPort = port;

  return {
    get port() {
      return actualPort;
    },
    rootPath,
    start: () =>
      new Promise<void>((resolve, reject) => {
        setupSigtermForwarding();

        const maxAttempts = 10;
        let attempt = 0;

        const tryListen = (p: number) => {
          attempt++;
          httpServer.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE" && attempt < maxAttempts) {
              tryListen(p + 1);
            } else {
              reject(err);
            }
          });
          httpServer.listen(p, () => {
            actualPort = p;
            logOp("server:start", rootPath);
            resolve();
          });
        };

        tryListen(port);
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(cleanupInterval);
        for (const child of activeChildren) {
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        }
        httpServer.close(() => resolve());
      }),
  };
}
