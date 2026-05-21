/**
 * Unified VM proxy routes.
 *
 * Consolidates the previously separate `vm-file`, `vm-exec`, `vm-setup`,
 * `vm-events`, and `vm-preview-fetch` route files into one router under:
 *
 *   /api/:org/vm/:vmId/:branch/*
 *
 * The URL shape mirrors the daemon's own `/_decopilot_vm/*` surface, making
 * the proxy transparent and uniform. Auth + claim resolution is performed
 * once in the `resolveVmClaim` middleware and shared by all sub-routes.
 */

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { createMiddleware } from "hono/factory";
import { composeSandboxRef } from "@decocms/sandbox/runner";
import type { ClaimPhase, SandboxRunner } from "@decocms/sandbox/runner";
import { computeClaimHandle } from "../../sandbox/claim-handle";
import { getOrInitSharedRunner } from "../../sandbox/lifecycle";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import type { Env } from "../hono-env";
import { handleVmEvents } from "./vm-events-handler";

// ---- Middleware types -------------------------------------------------------

interface VmClaim {
  claimName: string;
  /** Null when no sandbox runner is configured on this mesh instance. */
  runner: SandboxRunner | null;
  virtualMcpId: string;
  branch: string;
  userId: string;
  projectRef: string;
  virtualMcpMetadata: Record<string, unknown> | null;
}

type VmEnv = Env & { Variables: Env["Variables"] & { vmClaim: VmClaim } };

// ---- Shared middleware ------------------------------------------------------

/**
 * Resolves auth, org ownership, claim handle, and runner for all VM routes.
 * Runner may be `null` — the events handler streams a `failed` phase SSE in
 * that case; other handlers return 503 JSON via `requireRunner()`.
 */
const resolveVmClaim = createMiddleware<VmEnv>(async (c, next) => {
  const ctx = c.var.meshContext;
  try {
    requireAuth(ctx);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const userId = getUserId(ctx);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  let organization: ReturnType<typeof requireOrganization>;
  try {
    organization = requireOrganization(ctx);
  } catch {
    return c.json({ error: "Organization scope required" }, 403);
  }

  const virtualMcpId = c.req.param("vmId");
  const branch = c.req.param("branch");
  if (!virtualMcpId || !branch) {
    return c.json({ error: "vmId and branch are required" }, 400);
  }

  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
    return c.json({ error: "Virtual MCP not found" }, 404);
  }

  const projectRef = composeSandboxRef({
    orgId: organization.id,
    virtualMcpId,
    branch,
  });
  const claimName = computeClaimHandle({ userId, projectRef }, branch);
  const runner = await getOrInitSharedRunner();

  c.set("vmClaim", {
    claimName,
    runner,
    virtualMcpId,
    branch,
    userId,
    projectRef,
    virtualMcpMetadata:
      (virtualMcp.metadata as Record<string, unknown>) ?? null,
  });
  return next();
});

/** Guard for routes that need a non-null runner. Returns the runner or a 503. */
function requireRunner(c: Context<VmEnv>): SandboxRunner | Response {
  const { runner } = c.get("vmClaim");
  if (!runner) {
    return c.json({ error: "No sandbox runner configured" }, 503);
  }
  return runner;
}

// ---- Proxy helpers ----------------------------------------------------------

async function proxyDaemon(
  c: Context<VmEnv>,
  daemonPath: string,
  opts?: {
    method?: "GET" | "POST" | "PUT";
    forwardJsonBody?: boolean;
    signal?: AbortSignal;
    /** Map 404 to 410 (sandbox needs re-provision). */
    map404to410?: boolean;
  },
) {
  const runner = requireRunner(c);
  if (runner instanceof Response) return runner;

  const { claimName } = c.get("vmClaim");
  const method = opts?.method ?? "POST";
  let body: string | null = null;
  const headers = new Headers();

  if (opts?.forwardJsonBody) {
    body = await c.req.text();
    headers.set("content-type", "application/json");
  }

  let upstream: Response;
  try {
    upstream = await runner.proxyDaemonRequest(claimName, daemonPath, {
      method,
      headers,
      body,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Daemon unreachable: ${message}` }, 502);
  }

  if (opts?.map404to410 && upstream.status === 404) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* ignore */
    }
    return c.json(
      {
        error:
          "Sandbox handle is gone. The sandbox needs to be re-provisioned.",
      },
      410,
    );
  }

  const text = await upstream.text();
  const contentType =
    upstream.headers.get("content-type") ?? "application/json";
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": contentType },
  });
}

// ---- Preview fetch ----------------------------------------------------------

const ALLOWED_PATHS = new Set(["/.decofile", "/live/_meta"]);

// ---- Setup validation -------------------------------------------------------

const SETUP_STEPS = ["clone", "install", "start"] as const;
type SetupStep = (typeof SETUP_STEPS)[number];

function isSetupStep(value: string): value is SetupStep {
  return (SETUP_STEPS as readonly string[]).includes(value);
}

// ---- Route factory ----------------------------------------------------------

export const createVmRoutes = () => {
  const app = new Hono<VmEnv>();

  // Apply middleware to all sub-routes
  app.use("/:vmId/:branch/*", resolveVmClaim);

  // -- File write/read (base64-encoded body) --------------------------------
  app.post("/:vmId/:branch/write", (c) =>
    proxyDaemon(c, "/_decopilot_vm/write", { forwardJsonBody: true }),
  );
  app.post("/:vmId/:branch/read", (c) =>
    proxyDaemon(c, "/_decopilot_vm/read", { forwardJsonBody: true }),
  );

  // -- Script exec/kill -----------------------------------------------------
  app.post("/:vmId/:branch/exec/:script", (c) => {
    const script = c.req.param("script");
    if (!script) return c.json({ error: "missing script name" }, 400);
    return proxyDaemon(c, `/_decopilot_vm/exec/${encodeURIComponent(script)}`);
  });

  app.post("/:vmId/:branch/exec/:script/kill", (c) => {
    const script = c.req.param("script");
    if (!script) return c.json({ error: "missing script name" }, 400);
    return proxyDaemon(
      c,
      `/_decopilot_vm/exec/${encodeURIComponent(script)}/kill`,
    );
  });

  // -- Tenant config --------------------------------------------------------
  app.get("/:vmId/:branch/config", (c) =>
    proxyDaemon(c, "/_decopilot_vm/config", {
      method: "GET",
      map404to410: true,
    }),
  );
  app.put("/:vmId/:branch/config", (c) =>
    proxyDaemon(c, "/_decopilot_vm/config", {
      method: "PUT",
      forwardJsonBody: true,
      map404to410: true,
    }),
  );

  // -- Setup retry ----------------------------------------------------------
  app.post("/:vmId/:branch/setup/:step", (c) => {
    const step = c.req.param("step");
    if (!step || !isSetupStep(step)) {
      return c.json(
        { error: `step must be one of: ${SETUP_STEPS.join(", ")}` },
        400,
      );
    }
    return proxyDaemon(c, `/_decopilot_vm/setup/${step}`, {
      signal: c.req.raw.signal,
      map404to410: true,
    });
  });

  // -- SSE events -----------------------------------------------------------
  app.get("/:vmId/:branch/events", (c) => {
    const claim = c.get("vmClaim");

    // No runner → stream a single failed phase so the UI shows an error
    // rather than the EventSource receiving a non-SSE 503 JSON response.
    if (!claim.runner) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: "phase",
          data: JSON.stringify({
            kind: "failed",
            reason: "unknown",
            message: "No sandbox runner configured on this mesh.",
          } satisfies ClaimPhase),
        });
      });
    }

    return handleVmEvents(c as unknown as Context<Env>, {
      ctx: c.var.meshContext,
      claimName: claim.claimName,
      runner: claim.runner,
      branch: claim.branch,
      userId: claim.userId,
      projectRef: claim.projectRef,
      virtualMcpMetadata: claim.virtualMcpMetadata,
    });
  });

  // -- Preview fetch (CORS proxy) -------------------------------------------
  app.get("/:vmId/:branch/preview-fetch", async (c) => {
    const runner = requireRunner(c);
    if (runner instanceof Response) return runner;

    const { claimName } = c.get("vmClaim");
    const path = c.req.query("path");
    if (!path) {
      return c.json({ error: "path query parameter is required" }, 400);
    }
    if (!ALLOWED_PATHS.has(path)) {
      return c.json({ error: "Path not allowed" }, 403);
    }

    const previewUrl = await runner.getPreviewUrl(claimName);
    if (!previewUrl) {
      return c.json({ error: "Preview not available" }, 502);
    }

    const base = previewUrl.replace(/\/+$/, "");
    let upstream: Response;
    try {
      upstream = await fetch(`${base}${path}`);
    } catch {
      return c.json({ error: "Preview unreachable" }, 502);
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  });

  return app;
};
