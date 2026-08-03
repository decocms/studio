/**
 * local-api e2e: health + baseline routing.
 *
 * Pins `GET /health` (no-auth, byte-parity shape with the daemon — see
 * the native local-API contract) and that an unknown route
 * returns a 404 JSON error rather than falling through to the reverse proxy.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  authHeaders,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  type LocalApi,
  startLocalApi,
  stopLocalApi,
  url,
} from "./helpers";

describeLocalApi("local-api e2e: health", () => {
  let a: LocalApi;
  beforeAll(async () => {
    a = await startLocalApi();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopLocalApi(a);
  }, HOOK_TIMEOUT_MS);

  it("GET /health works without auth", async () => {
    const res = await fetch(url(a, "/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      bootId: string;
      configured: boolean;
      orchestrator: { running: boolean; pending: number };
      setup: { running: boolean; done: boolean };
    };
    expect(typeof body.ready).toBe("boolean");
    expect(typeof body.bootId).toBe("string");
    expect(typeof body.configured).toBe("boolean");
    expect(body.orchestrator).toEqual({ running: false, pending: 0 });
    expect(body.setup).toEqual({ running: false, done: true });
  });

  it("GET /health tolerates an arbitrary Authorization header", async () => {
    const res = await fetch(url(a, "/health"), {
      headers: { Authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(200);
  });

  // Round-1 integrator fix (2026-07-18): `/health` used to be wired OUTSIDE
  // any CORS/Origin treatment at all (only `guard`, applied to every OTHER
  // route, ran `cors::validate`/`apply_headers`) — a real cross-origin
  // `fetch()` from the webview (`tauri://localhost` -> `http://127.0.0.1:
  // <port>`) got a `200` with no `Access-Control-Allow-Origin` header, which
  // the browser's own CORS enforcement turns into an opaque network error at
  // the call site (reproduced via Phase 3's self-test — see
  // the native Tauri integration's "Discovered gap" section). `router.rs`'s new
  // `cors_only` middleware (`.route_layer()`-scoped to `/health` alone)
  // closes this: `/health` now gets Origin-checked and CORS-headed exactly
  // like every other route, per `the native local-API contract
  // #origin-validation--cors`'s "every request (including simple GETs)" —
  // it just still never checks the bearer.
  it("GET /health echoes Access-Control-Allow-Origin for an allowlisted Origin", async () => {
    const res = await fetch(url(a, "/health"), {
      headers: { Origin: "tauri://localhost" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "tauri://localhost",
    );
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("GET /health rejects a non-allowlisted Origin with 403 forbidden_origin, before auth", async () => {
    const res = await fetch(url(a, "/health"), {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({
      error: "forbidden_origin",
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("GET /health with no Origin header at all is unaffected (same-machine caller)", async () => {
    // No `Origin` header — same as every other no-Origin request in this
    // suite (Node's `fetch` never sets one); confirms the fix didn't
    // regress the plain no-auth, no-CORS-needed case the tests above pin.
    const res = await fetch(url(a, "/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("preflight echoes requested headers for an allowed origin (mcp-protocol-version regression)", async () => {
    // Found live in the webview: the MCP streamable-HTTP client sends
    // `mcp-protocol-version` (mesh's own CORS allowlists it —
    // apps/api/src/api/app.ts), but the old hardcoded preflight list here
    // rejected it, killing every /api/:org/mcp/* call. The preflight now
    // echoes Access-Control-Request-Headers for an allowed origin.
    const res = await fetch(url(a, "/_local/agent-capabilities"), {
      method: "OPTIONS",
      headers: {
        Origin: "tauri://localhost",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, mcp-protocol-version",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "authorization, mcp-protocol-version",
    );
  });

  it("responses expose Mcp-Session-Id and WWW-Authenticate to allowed cross-origin callers", async () => {
    // Cross-origin JS cannot READ response headers unless exposed; the MCP
    // client must read Mcp-Session-Id (same-origin prod web never needs
    // this, so only this suite pins it).
    const res = await fetch(url(a, "/_local/agent-capabilities"), {
      headers: { Origin: "tauri://localhost", ...authHeaders() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-expose-headers")).toBe(
      "Mcp-Session-Id, WWW-Authenticate",
    );
  });

  // A path outside /health, /_sandbox/*, and /_local/* falls through to
  // the app-API intercept-or-proxy fallback (`routes/upstream.rs::proxy`,
  // merged in at the router root — see `router.rs`'s module doc), NOT the
  // reverse-proxy-to-dev-server family anymore: that family moved to its
  // own dedicated PREVIEW listener (a separate port, see
  // `local_api::ServerHandle`'s doc comment) once the port-router split
  // landed. The reverse-proxy family's own behavior (503 "No dev server
  // running", HTML bootstrap injection, etc.) is pinned by the parity
  // oracle (`daemon.proxy.e2e.test.ts` run against the Rust binary via
  // DAEMON_E2E_CMD) against the MAIN port, since the daemon itself has no
  // port split — see `real-ui-passthrough.e2e.test.ts` / `git-sandbox.e2e.test.ts`
  // for this suite's own coverage of the two listeners' current split.
});
