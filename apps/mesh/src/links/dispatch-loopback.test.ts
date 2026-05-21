/**
 * Dispatch loopback test — exercises the FULL HMAC path end-to-end
 * in-process, from cluster-side `remoteDispatch` through the daemon's
 * `handleDispatchRequest` and back as SSE chunks. This catches any
 * asymmetry between the key used to SIGN at the cluster and the key
 * used to VERIFY at the daemon — the exact bug class that turned every
 * remote dispatch into a 401 in production.
 *
 * Why this needs its own test file (vs. extending `loopback.test.ts`):
 *   - `loopback.test.ts` covers the registration handshake only.
 *   - The dispatch path uses a different secret usage (HMAC signing both
 *     control-plane AND per-sandbox routes), and the bug lived in the
 *     asymmetry between what was stored in the registry vs. what the
 *     link binary received. Verifying just the registration round-trip
 *     was insufficient.
 *
 * Strategy:
 *   1. Build an in-process "cluster" Hono app with `registerLinksRoutes`.
 *   2. Have the link `registerWithCluster` call it via a synthetic
 *      `fetch` — this returns the raw `linkSecret` exactly like prod.
 *   3. Pull the LinkEntry back from the same registry — this is the
 *      object the cluster's dispatch path actually signs with.
 *   4. Wire `remoteDispatch` to a fake daemon handler (`handleDispatchRequest`
 *      from `@decocms/sandbox/daemon/routes/dispatch`) configured with
 *      `bearerSecret = linkSecret` (raw, as the daemon holds it).
 *   5. Drive a FakeHarness end-to-end and assert the cluster receives
 *      the harness's chunks back through the SSE parser.
 *
 * If the symmetric-signing invariant ever breaks again (e.g. someone
 * re-introduces hash-at-rest on one side but not the other), this test
 * dies on the dispatch fetch returning 401.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { handleDispatchRequest } from "@decocms/sandbox/daemon/routes/dispatch";
import { fixtures } from "./protocol";
import type { HarnessStreamInput } from "../harnesses";
import { registerWithCluster } from "../link-daemon/registration";
import { remoteDispatch } from "../harnesses/remote-dispatch";
import { createInMemoryLinkRegistry } from "./link-registry";
import { registerLinksRoutes } from "./routes";

const TEST_USER_SUB = "user-dispatch-loopback";
const TEST_SESSION_TOKEN = "session-dispatch-loopback";
// Must hit the cluster's `isLocalhostUrl` check (hostname === "localhost")
// for the cluster to honor our tunnelUrl override. Otherwise it derives
// `https://link-<userSub>.deco.host` and our test router stops matching.
const TUNNEL_BASE_URL = "http://localhost:65535";

function buildClusterApp() {
  const registry = createInMemoryLinkRegistry({ nowSeconds: () => 0 });
  const app = new Hono();
  registerLinksRoutes(app, {
    linkRegistry: registry,
    getAuthenticatedUserSub: (c) => {
      const auth = c.req.header("authorization");
      const session = c.req.header("x-deco-session");
      if (auth?.startsWith("Bearer ") || session) return TEST_USER_SUB;
      return null;
    },
    allowLocalhostLinks: true,
  });
  return { app, registry };
}

/**
 * A tiny harness that yields a deterministic series of `UIMessageChunk`s.
 * The cluster-side `remoteDispatch` parses these back out of SSE and
 * yields them to the caller; the test asserts the full set arrives.
 */
function makeFakeHarness() {
  return {
    async *stream() {
      yield { type: "start", id: "msg-loopback" } as const;
      yield {
        type: "text-delta",
        id: "msg-loopback",
        delta: "hello loopback",
      } as const;
      yield { type: "finish", finishReason: "stop" } as const;
    },
  };
}

/**
 * Build a `fetch`-compatible function that routes:
 *   - Requests to the cluster app (any host equal to "cluster.local")
 *     through Hono.
 *   - Requests to the link's tunnel URL through the daemon's
 *     `handleDispatchRequest` (we expose it as a bare Request handler).
 *
 * Anything else is rejected — the test should not be making other calls.
 */
function makeRouter(
  clusterApp: Hono,
  daemonHandler: (req: Request) => Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    if (url.host === "cluster.local") {
      return clusterApp.fetch(req);
    }
    if (req.url.startsWith(TUNNEL_BASE_URL)) {
      return daemonHandler(req);
    }
    throw new Error(`unexpected fetch target in test: ${req.url}`);
  }) as typeof fetch;
}

describe("dispatch loopback (in-process)", () => {
  it("registers, signs, dispatches, and round-trips SSE chunks", async () => {
    const { app, registry } = buildClusterApp();

    // The daemon-side state: we'll receive whatever secret the link does
    // and use it to verify HMAC signatures on incoming requests. Setting
    // this before `registerWithCluster` would require knowing the secret
    // ahead of time — so we initialize daemonBearer after registration
    // and capture it via a mutable holder.
    let daemonBearer: string | null = null;
    const daemonHandler = async (req: Request): Promise<Response> => {
      if (!daemonBearer) {
        throw new Error("daemonBearer not set before dispatch");
      }
      return handleDispatchRequest(req, {
        bearerSecret: daemonBearer,
        lookupHarness: () => makeFakeHarness(),
        seenNonce: () => false,
      });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeRouter(app, daemonHandler);
    try {
      // 1) Register — get the raw linkSecret the link binary would hold.
      const { linkSecret } = await registerWithCluster({
        clusterBaseUrl: "http://cluster.local",
        sessionToken: TEST_SESSION_TOKEN,
        machineId: "machine-dispatch-loopback",
        cliVersion: "0.0.0-test",
        capabilities: ["claude-code"],
        tunnelUrl: TUNNEL_BASE_URL,
      });
      daemonBearer = linkSecret;

      // 2) Pull the stored entry back. THIS is the value the cluster
      //    dispatch path will sign HMACs with. The bug we're guarding
      //    against was `stored.linkSecret !== linkSecret` — different
      //    key material on the two ends.
      const stored = await registry.get(TEST_USER_SUB);
      if (!stored) throw new Error("registry missing the link we just put");

      // Sanity: if these ever drift apart again, every dispatch fails
      // with 401. Assert symmetry explicitly so a later refactor doesn't
      // silently re-introduce the asymmetry without also tripping the
      // SSE assertion below.
      expect(stored.linkSecret).toBe(linkSecret);

      // 3) Drive remoteDispatch against the daemon via the routed fetch.
      const chunks: unknown[] = [];
      // FIXTURE_MINIMAL_INPUT types `messages` as `Record<string, unknown>[]`
      // (the wire shape is opaque at the link-protocol layer); the harness
      // type narrows it to `ChatMessage[]`. The wire test doesn't drive any
      // message-shape logic so the cast is safe.
      const harnessInput = {
        ...fixtures.FIXTURE_MINIMAL_INPUT,
        runId: "run-loopback-1",
        signal: new AbortController().signal,
      } as unknown as HarnessStreamInput;
      // Per-daemon-tunnel migration: the cluster now talks to the
      // daemon DIRECTLY (no link reverse-proxy hop), at a per-handle
      // `sandboxUrl` returned by the link's `POST /api/sandboxes`. In
      // this in-process loopback we point sandboxUrl at the same
      // TUNNEL_BASE_URL so the routed fetch still resolves to the
      // daemon handler — the URL path (`/_decopilot_vm/dispatch`) is
      // what the daemon's HMAC verification matches against.
      const iter = remoteDispatch(
        "claude-code",
        harnessInput,
        {
          tunnelUrl: stored.tunnelUrl,
          linkSecret: stored.linkSecret,
        },
        stored.tunnelUrl,
      );
      for await (const chunk of iter) {
        chunks.push(chunk);
      }

      // 4) Assert the round-trip: the chunks emitted by the FakeHarness
      //    on the daemon side made it back through SSE parsing as the
      //    same UIMessageChunk shapes.
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      // The harness emitted: start → text-delta → finish.
      const types = chunks
        .map((c) => (c as { type?: string }).type)
        .filter((t): t is string => typeof t === "string");
      expect(types).toContain("start");
      expect(types).toContain("text-delta");
      expect(types).toContain("finish");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dispatch fails with 401 when cluster signs with a different secret than the daemon verifies with", async () => {
    // Negative control: confirms the test's HMAC plumbing is sensitive
    // to a key mismatch — i.e., if we DELIBERATELY desymmetrize the
    // secret, the dispatch fetch surfaces the 401 the production bug
    // would produce. Without this, the happy-path test could be passing
    // for the wrong reason (e.g., HMAC verification accidentally
    // bypassed).
    const { app, registry } = buildClusterApp();

    const daemonHandler = (req: Request): Promise<Response> =>
      handleDispatchRequest(req, {
        bearerSecret: "completely-different-secret-32-bytes-pad",
        lookupHarness: () => makeFakeHarness(),
        seenNonce: () => false,
      });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeRouter(app, daemonHandler);
    try {
      const { linkSecret } = await registerWithCluster({
        clusterBaseUrl: "http://cluster.local",
        sessionToken: TEST_SESSION_TOKEN,
        machineId: "machine-mismatch",
        cliVersion: "0.0.0-test",
        capabilities: ["claude-code"],
        tunnelUrl: TUNNEL_BASE_URL,
      });
      const stored = await registry.get(TEST_USER_SUB);
      if (!stored) throw new Error("registry missing entry");
      expect(stored.linkSecret).toBe(linkSecret);

      const harnessInput = {
        ...fixtures.FIXTURE_MINIMAL_INPUT,
        runId: "run-mismatch-1",
        signal: new AbortController().signal,
      } as unknown as HarnessStreamInput;
      const iter = remoteDispatch(
        "claude-code",
        harnessInput,
        {
          tunnelUrl: stored.tunnelUrl,
          linkSecret: stored.linkSecret,
        },
        stored.tunnelUrl,
      );
      // Consuming the iterator triggers the dispatch fetch; the 401
      // surfaces as a thrown Error from `remoteDispatch`.
      await expect(
        (async () => {
          for await (const _ of iter) {
            // no-op
          }
        })(),
      ).rejects.toThrow(/HTTP 401/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
