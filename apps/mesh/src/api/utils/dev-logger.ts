import type { Context, Next } from "hono";
import { isTuiConsoleIntercepted } from "../../cli/cli-store";
import { logEmitter } from "../../cli/log-emitter";

// ANSI color codes for elegant logging
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  // Request methods
  GET: "\x1b[36m", // cyan
  POST: "\x1b[33m", // yellow
  PUT: "\x1b[35m", // magenta
  DELETE: "\x1b[31m", // red
  // Status codes
  ok: "\x1b[32m", // green
  redirect: "\x1b[36m", // cyan
  clientError: "\x1b[33m", // yellow
  serverError: "\x1b[31m", // red
  // Special
  mcp: "\x1b[35m", // magenta for MCP
  tool: "\x1b[96m", // bright cyan for tool names
  duration: "\x1b[90m", // gray
};

const getStatusColor = (status: number) => {
  if (status >= 500) return colors.serverError;
  if (status >= 400) return colors.clientError;
  if (status >= 300) return colors.redirect;
  return colors.ok;
};

const getMethodColor = (method: string) => {
  return colors[method as keyof typeof colors] || colors.reset;
};

/**
 * Sanitize strings for safe logging by removing control characters
 * Prevents log forging and terminal escape injection attacks
 */
const sanitizeForLog = (str: string): string => {
  return (
    str
      .replace(/\r/g, "") // Remove carriage returns
      .replace(/\n/g, "") // Remove newlines
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "") // Remove ANSI escape sequences
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
  ); // Remove other control characters
};

export function devLogger() {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;

    // Skip noisy paths
    if (path === "/api/auth/get-session" || path.includes("favicon")) {
      await next();
      return;
    }

    // For MCP calls, extract tool/method info
    // Note: In production, we skip body cloning for performance. Detailed parsing
    // happens deeper in the call stack where the body is already parsed (e.g., in proxy routes).
    let mcpInfo = "";
    let isMcpCall = false;
    if (path.startsWith("/mcp") && method === "POST") {
      isMcpCall = true;
      // Skip expensive body cloning in production
      try {
        // Only attempt to parse if Content-Type suggests JSON and body exists
        const contentType = c.req.header("Content-Type");
        if (contentType?.includes("application/json")) {
          const cloned = c.req.raw.clone();
          const body = (await cloned.json()) as {
            method?: string;
            params?: {
              name?: string;
              arguments?: Record<string, unknown>;
            };
          };
          if (body.method === "tools/call" && body.params?.name) {
            // Sanitize all user-provided fields before logging
            const toolName = sanitizeForLog(body.params.name);
            const args = body.params.arguments || {};

            // For event bus calls, show the event type prominently
            if (toolName === "EVENT_PUBLISH" && args.type) {
              const eventType = sanitizeForLog(String(args.type));
              mcpInfo = `${colors.tool}EVENT_PUBLISH${colors.reset} ${colors.bold}→ ${eventType}${colors.reset}`;
            } else if (toolName === "EVENT_SUBSCRIBE" && args.eventType) {
              const eventType = sanitizeForLog(String(args.eventType));
              mcpInfo = `${colors.tool}EVENT_SUBSCRIBE${colors.reset} ${colors.bold}← ${eventType}${colors.reset}`;
            } else if (toolName === "EVENT_UNSUBSCRIBE" && args.eventType) {
              const eventType = sanitizeForLog(String(args.eventType));
              mcpInfo = `${colors.tool}EVENT_UNSUBSCRIBE${colors.reset} ${colors.dim}✕ ${eventType}${colors.reset}`;
            } else {
              // Default: show tool name with arg keys (sanitized)
              const argKeys = Object.keys(args).map((k) => sanitizeForLog(k));
              const argsStr =
                argKeys.length > 0
                  ? argKeys.slice(0, 3).join(",") +
                    (argKeys.length > 3 ? "…" : "")
                  : "";
              mcpInfo = `${colors.tool}${toolName}${colors.dim}(${argsStr})${colors.reset}`;
            }
          } else if (body.method) {
            mcpInfo = `${colors.dim}${sanitizeForLog(body.method)}${colors.reset}`;
          }
        }
      } catch {
        // Ignore parse errors - body parsing failures shouldn't break the request
        // Detailed error logging happens deeper in the stack
      }
    }

    // Format path - shorten connection IDs (sanitize path for safety)
    let displayPath = sanitizeForLog(path);
    if (path.startsWith("/mcp/conn_")) {
      const connId = path.split("/")[2] ?? "";
      displayPath = `/mcp/${colors.mcp}${sanitizeForLog(connId.slice(0, 12))}…${colors.reset}`;
    } else if (path === "/mcp") {
      displayPath = `${colors.mcp}/mcp${colors.reset}`;
    } else if (path === "/mcp/registry") {
      displayPath = `${colors.mcp}/mcp/registry${colors.reset}`;
    }

    // Log incoming request (skip when TUI intercepts console to avoid duplicates)
    const methodColor = getMethodColor(method);
    const arrow = isMcpCall ? "◀" : "←";
    if (!isTuiConsoleIntercepted()) {
      console.log(
        `${colors.dim}${arrow}${colors.reset} ${methodColor}${method}${colors.reset} ${displayPath}${mcpInfo ? ` ${mcpInfo}` : ""}`,
      );
    }

    // Wrap next() in try/finally to ensure completion logs always run
    // even if downstream throws an error
    try {
      await next();
    } finally {
      const duration = Date.now() - start;
      const status = c.res.status;
      const statusColor = getStatusColor(status);
      const durationStr =
        duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`;
      const outArrow = isMcpCall ? "▶" : "→";

      if (!isTuiConsoleIntercepted()) {
        console.log(
          `${colors.dim}${outArrow}${colors.reset} ${methodColor}${method}${colors.reset} ${displayPath}${mcpInfo ? ` ${mcpInfo}` : ""} ${statusColor}${status}${colors.reset} ${colors.duration}${durationStr}${colors.reset}`,
        );
      }

      // Emit to Ink UI log emitter
      logEmitter.emit("request", {
        method,
        path: sanitizeForLog(path),
        status,
        duration,
        timestamp: new Date(),
      });
    }
  };
}
