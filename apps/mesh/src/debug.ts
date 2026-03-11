/**
 * Internal Debug Server
 *
 * A separate server for debugging/diagnostics that runs on an internal port.
 * Only enabled when ENABLE_DEBUG_SERVER=true.
 *
 * Endpoints:
 * - GET /health       - Health check with uptime
 * - GET /memory       - Memory usage stats
 * - GET /heap-snapshot - Download heap snapshot
 * - GET /gc           - Trigger garbage collection
 * - GET /prestop-hook - Save heap snapshot if PRESTOP_HEAP_SNAPSHOT_DIR is set
 */
import v8 from "node:v8";
import { rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { env } from "./env";

export interface DebugServerConfig {
  port: number;
  hostname?: string;
}

export function startDebugServer(config: DebugServerConfig) {
  const { port, hostname = "0.0.0.0" } = config;

  return Bun.serve({
    port,
    hostname,
    fetch: async (request) => {
      const url = new URL(request.url);

      // GET /health - simple health check
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", uptime: process.uptime() });
      }

      // GET /memory - memory usage stats
      if (url.pathname === "/memory") {
        return Response.json({
          ...process.memoryUsage(),
          uptimeSeconds: process.uptime(),
        });
      }

      // GET /heap-snapshot - generate and download heap snapshot
      if (url.pathname === "/heap-snapshot") {
        const timestamp = Date.now();

        try {
          const snapshotPath = v8.writeHeapSnapshot();
          const file = Bun.file(snapshotPath);

          return new Response(file, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="heap-${timestamp}.heapsnapshot"`,
            },
          });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 });
        }
      }

      // GET /gc - force garbage collection (if available)
      if (url.pathname === "/gc") {
        if (typeof Bun.gc === "function") {
          Bun.gc(true);
          return Response.json({ status: "gc triggered" });
        }
        return Response.json({ status: "gc not available" }, { status: 501 });
      }

      // GET /prestop-hook - save heap snapshot if PRESTOP_HEAP_SNAPSHOT_DIR is set
      if (url.pathname === "/prestop-hook") {
        const directory = env.PRESTOP_HEAP_SNAPSHOT_DIR;

        if (!directory) {
          return Response.json({
            status: "skipped",
            reason: "PRESTOP_HEAP_SNAPSHOT_DIR not set",
          });
        }

        try {
          await mkdir(directory, { recursive: true });

          const snapshotPath = v8.writeHeapSnapshot();
          const podName = env.HOSTNAME ?? env.POD_NAME ?? "unknown";
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const filename = `${podName}-${timestamp}.heapsnapshot`;
          const destPath = join(directory, filename);

          await rename(snapshotPath, destPath);

          const mem = process.memoryUsage();
          console.log("[prestop-hook] Heap snapshot saved:", destPath);

          return Response.json({
            status: "saved",
            path: destPath,
            memory: {
              rss: mem.rss,
              heapUsed: mem.heapUsed,
              external: mem.external,
            },
          });
        } catch (error) {
          console.error("[prestop-hook] Failed to save heap snapshot:", error);
          return Response.json({ error: String(error) }, { status: 500 });
        }
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
}
