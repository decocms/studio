/**
 * The link daemon's public HTTP surface. Every request is HMAC-verified
 * against the link's `linkSecret`. Routes:
 *
 *   POST   /api/sandboxes              — ensure a sandbox for a handle
 *   DELETE /api/sandboxes/<handle>     — tear it down
 *
 * Browser preview + cluster→daemon RPCs are NOT served here anymore —
 * each daemon has its own warp tunnel (<handle>.deco.host) opened by
 * the laptop provider at ensureSandbox time. The cluster reads the
 * URL from the link's response, persists it in sandbox_runner_state,
 * and talks to the daemon directly.
 *
 * 401 = bad/missing signature; 404 = unknown path / unknown handle.
 *
 * Nonce-replay protection is delegated to the caller via `seenNonce` /
 * `recordNonce` so production can wire up a TTL'd Map without the
 * verifier needing direct mutable state.
 */

import { verifyRequest } from "@/links/protocol";
import type { LaptopSandboxProvider, RepoRef } from "./sandbox-provider";

export interface ControlPlaneDeps {
  provider: LaptopSandboxProvider;
  linkSecret: string;
  seenNonce: (nonce: string) => boolean;
  recordNonce: (nonce: string) => void;
}

interface EnsureSandboxBody {
  handle: string;
  repo?: RepoRef;
}

export function makeControlPlaneHandler(
  deps: ControlPlaneDeps,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    const requestBody =
      method === "GET" || method === "HEAD" ? "" : await req.text();

    const verification = verifyRequest({
      secret: deps.linkSecret,
      method,
      path: url.pathname,
      body: requestBody,
      headers: Object.fromEntries(req.headers),
      seenNonce: deps.seenNonce,
    });
    if (!verification.valid) {
      return new Response(
        JSON.stringify({ error: "unauthorized", reason: verification.reason }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }
    const nonce =
      req.headers.get("x-mesh-nonce") ?? req.headers.get("X-Mesh-Nonce");
    if (nonce) deps.recordNonce(nonce);

    if (url.pathname === "/api/sandboxes" && method === "POST") {
      let parsed: EnsureSandboxBody;
      try {
        parsed = JSON.parse(requestBody) as EnsureSandboxBody;
      } catch {
        return new Response(JSON.stringify({ error: "invalid_json" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (typeof parsed.handle !== "string" || parsed.handle.length === 0) {
        return new Response(JSON.stringify({ error: "missing_handle" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const { sandboxUrl } = await deps.provider.ensureSandbox(parsed);
      return new Response(JSON.stringify({ sandboxUrl }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname.startsWith("/api/sandboxes/") && method === "DELETE") {
      const handle = url.pathname.slice("/api/sandboxes/".length);
      if (!handle) {
        return new Response(JSON.stringify({ error: "missing_handle" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      await deps.provider.deleteSandbox(handle);
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  };
}
