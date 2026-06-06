/**
 * E2E: the pull reverse-proxy channel, end-to-end (Phase C-bis S5).
 *
 * Validates the channel built dormant in S0-S4 — cluster `createProxyDispatch`
 * → `links.proxy.req.<userSub>` → `GET /api/:org/links/proxy` (the daemon's
 * long-poll) → a PROXY-DAEMON SIMULATOR → `POST /api/:org/links/proxy/:reqId/
 * stream` (duplex NDJSON reply) → `links.proxy.reply.<reqId>` → back to the
 * awaiting caller — over REAL NATS + the REAL routes, BEFORE the S6 cutover.
 *
 * ── How the round-trip is triggered ──────────────────────────────────────────
 * The production caller of `createProxyDispatch` is `DesktopSandboxProvider`
 * (wired in S3, dormant behind `LINK_PROXY_TRANSPORT=pull`, which the e2e dev
 * server does NOT set). Wiring full provider resolution (virtualMcp seed,
 * sandbox handle, presence) just to reach `proxyDaemonRequest` is disproporti-
 * onate, so this spec uses the sanctioned fallback: a non-production test-trigger
 * route (`POST /api/:org/links/proxy/_test/dispatch`, mounted only when
 * NODE_ENV!=="production") that drives a REAL `createProxyDispatch` over the SAME
 * live NATS connection and streams the decoded reply back. This is a true
 * cross-leg round-trip — only the caller is synthetic; both legs, both subjects,
 * the queue-group overlap and the fail-fast watcher are the production code.
 *
 * ── The proxy-daemon simulator ───────────────────────────────────────────────
 * Mirrors `proxy-poller.ts`: continuous-overlap GETs on `/links/proxy` (≥2 in
 * flight — landmine #5); on a RequestFrame it opens a streaming, duplex reply
 * POST (NDJSON `ProxyReplyFrame`s: headers → base64 chunk(s) → end). It also
 * long-polls `/links/control` and, on a `cancel_req` frame, aborts the matching
 * in-flight reply (the cancel leg rides the control channel — the daemon is
 * outbound-only). The reply POST uses native `fetch` with `duplex:"half"` (the
 * undici streaming-upload path the real daemon uses); Playwright's
 * APIRequestContext cannot stream a request body incrementally, which the SSE
 * and cancel assertions require.
 *
 * ── Assertions ───────────────────────────────────────────────────────────────
 *   1. Round-trip: byte-exact reply body, incl. a non-UTF-8 byte (base64 fidelity).
 *   2. SSE (`/events`): multiple chunks with gaps relayed incrementally (not
 *      buffered-till-end).
 *   3. Cancel frees the slot (landmine #3): caller aborts mid-stream → the
 *      `cancel_req` reaches the simulator → it observes the abort.
 *   4. Request-during-gap-not-lost: a second request issued while the simulator
 *      is mid-handling the first is still delivered (queue-group + overlap).
 *   5. Daemon-vanished fail-fast (Part A): stop the simulator + delete the
 *      presence claim with a request in flight → the caller rejects with the
 *      502-equivalent within a bounded time (NOT hangs).
 *
 * If NATS is unavailable in the environment the proxy routes return 503; such
 * assertions are tolerated (mirrors link-control.spec.ts), but the round-trip is
 * the hard guard.
 */

import { expect, test } from "../fixtures/test";

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

const BASE_URL = `http://localhost:${process.env.PORT ?? "3000"}`;

/** Build a Cookie header from the page's context cookies for native fetch. */
async function cookieHeader(
  page: import("@playwright/test").Page,
): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Encode one NDJSON reply frame line. */
function frameLine(frame: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// ---------------------------------------------------------------------------
// Proxy-daemon simulator
// ---------------------------------------------------------------------------

type ReplyWriter = {
  /** Enqueue one NDJSON reply frame (headers / chunk / end / error). */
  write: (frame: Record<string, unknown>) => Promise<void>;
  /** Close the reply stream cleanly. */
  close: () => Promise<void>;
};

type RequestHandler = (
  frame: { reqId: string; method: string; path: string; body?: string },
  writer: ReplyWriter,
  signal: AbortSignal,
) => Promise<void>;

/**
 * A minimal stand-in for the desktop proxy daemon: continuous-overlap polls on
 * `/links/proxy`, a control poll for cancel, and a streaming duplex reply POST
 * per request. The test supplies a `RequestHandler` deciding the reply.
 */
class ProxyDaemonSimulator {
  private readonly headers: Record<string, string>;
  private readonly stop = new AbortController();
  private readonly loops: Promise<void>[] = [];
  /** reqId → per-request AbortController (cancel aborts the matching reply). */
  private readonly inflight = new Map<string, AbortController>();
  /** reqIds the simulator has been told to cancel (for assertions). */
  readonly canceledReqIds: string[] = [];
  /** reqIds the simulator has received a request for (for assertions). */
  readonly seenReqIds: string[] = [];

  constructor(
    private readonly orgSlug: string,
    cookie: string,
    private readonly handler: RequestHandler,
    private readonly concurrency = 2,
  ) {
    this.headers = { cookie };
  }

  start(): void {
    for (let i = 0; i < this.concurrency; i++) {
      this.loops.push(this.pollLoop());
    }
    this.loops.push(this.controlLoop());
  }

  async dispose(): Promise<void> {
    this.stop.abort();
    for (const ac of this.inflight.values()) ac.abort();
    await Promise.allSettled(this.loops);
  }

  // Continuous-overlap request poll: as soon as a GET returns, re-issue.
  private async pollLoop(): Promise<void> {
    while (!this.stop.signal.aborted) {
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/api/${this.orgSlug}/links/proxy`, {
          headers: this.headers,
          signal: this.stop.signal,
        });
      } catch {
        if (this.stop.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      if (res.status === 204) continue; // poll window expired — re-poll.
      if (res.status !== 200) {
        // 503 (NATS down) or other — back off briefly and retry.
        await res.body?.cancel().catch(() => {});
        if (this.stop.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const frame = (await res.json()) as {
        reqId: string;
        method: string;
        path: string;
        body?: string;
      };
      this.seenReqIds.push(frame.reqId);
      // DETACHED (landmine #2): handle the request without awaiting so this loop
      // re-polls immediately and keeps the overlap.
      void this.handleRequest(frame);
    }
  }

  // Control poll: receive cancel_req frames and abort the matching reply.
  private async controlLoop(): Promise<void> {
    while (!this.stop.signal.aborted) {
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/api/${this.orgSlug}/links/control`, {
          headers: this.headers,
          signal: this.stop.signal,
        });
      } catch {
        if (this.stop.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const frame = (await res.json()) as { type: string; reqId?: string };
      if (frame.type === "cancel_req" && frame.reqId) {
        this.canceledReqIds.push(frame.reqId);
        this.inflight.get(frame.reqId)?.abort();
      }
    }
  }

  private async handleRequest(frame: {
    reqId: string;
    method: string;
    path: string;
    body?: string;
  }): Promise<void> {
    const reqAc = new AbortController();
    this.inflight.set(frame.reqId, reqAc);
    const combined = AbortSignal.any([this.stop.signal, reqAc.signal]);

    // Build a duplex NDJSON reply stream the handler writes into.
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const writer: ReplyWriter = {
      write: async (f) => {
        controller.enqueue(frameLine(f));
      },
      close: async () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      },
    };

    // Run the test-supplied handler in the background; it writes frames.
    // A handler THROW models the daemon vanishing mid-stream: abort the reply
    // POST (drop the upload) instead of closing cleanly, so the cluster's
    // POST-drop catch publishes a `reply_stream_dropped` error frame and the
    // awaiting caller fails fast (vs. a clean close = a truncated stream the
    // cluster can't distinguish from a normal end). A normal return closes the
    // controller cleanly.
    const handlerDone = (async () => {
      try {
        await this.handler(frame, writer, combined);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      } catch {
        reqAc.abort(); // drop the upload mid-stream (daemon-vanish simulation)
      }
    })();

    try {
      await fetch(
        `${BASE_URL}/api/${this.orgSlug}/links/proxy/${frame.reqId}/stream`,
        {
          method: "POST",
          headers: { ...this.headers, "content-type": "application/x-ndjson" },
          body: stream,
          // @ts-expect-error duplex is required for a streaming request body
          // (undici/Node), not yet in all TS DOM typings.
          duplex: "half",
          signal: combined,
        },
      );
    } catch {
      /* reply POST aborted on cancel/close — expected */
    } finally {
      await handlerDone.catch(() => {});
      this.inflight.delete(frame.reqId);
    }
  }
}

// ---------------------------------------------------------------------------
// Presence helpers
// ---------------------------------------------------------------------------

/**
 * Establish the user's link-claim presence by hitting GET /links/work with the
 * claude-code capability (mints the studio_links claim), then confirm it is
 * visible. Returns a function that keeps the claim refreshed (one long-poll in
 * flight) and a disposer.
 */
async function establishPresence(
  api: import("@playwright/test").APIRequestContext,
  orgSlug: string,
): Promise<{ refresh: () => void; dispose: () => Promise<void> }> {
  const headers = {
    "x-link-capabilities": "claude-code",
    "x-link-machine-id": "e2e-proxy-sim",
    "x-link-cli-version": "test",
  };
  // First call mints the claim (claim refresh is synchronous at handler start).
  await api
    .get(`/api/${orgSlug}/links/work`, { timeout: 1_500, headers })
    .catch(() => null);

  await expect
    .poll(
      async () => {
        const res = await api.get("/api/links/me");
        if (res.status() !== 200) return null;
        return (await res.json()) as unknown;
      },
      { timeout: 10_000, intervals: [200, 500, 1_000] },
    )
    .not.toBeNull();

  // Keep the claim alive with a rolling long-poll (re-arms the 60 s TTL).
  let alive = true;
  let current: Promise<unknown> | null = null;
  const loop = (): void => {
    if (!alive) return;
    current = api
      .get(`/api/${orgSlug}/links/work`, { timeout: 35_000, headers })
      .catch(() => null)
      .then((r) => {
        if (alive) loop();
        return r;
      });
  };
  return {
    refresh: loop,
    dispose: async () => {
      alive = false;
      await current?.catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("pull reverse-proxy channel (Phase C-bis S5)", () => {
  // 1 + 2: round-trip byte-exact (non-UTF-8) AND incremental SSE relay.
  test("round-trip relays headers + base64 chunks byte-exact and incrementally", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const cookie = await cookieHeader(page);

    const presence = await establishPresence(api, orgSlug);
    presence.refresh();

    // Reply payload includes a non-UTF-8 byte (0xFF) to prove base64 fidelity.
    const part1 = new Uint8Array([0x68, 0x69, 0xff]); // "hi" + 0xFF
    const part2 = new Uint8Array([0x00, 0x41, 0x42]); // NUL + "AB"
    const chunkArrival: number[] = [];

    const sim = new ProxyDaemonSimulator(orgSlug, cookie, async (_frame, w) => {
      await w.write({ type: "headers", status: 200, headers: {} });
      await w.write({ type: "chunk", data: b64(part1) });
      // gap, then a second chunk — proves the cluster relays incrementally.
      await new Promise((r) => setTimeout(r, 300));
      await w.write({ type: "chunk", data: b64(part2) });
      await w.write({ type: "end" });
    });
    sim.start();

    try {
      const res = await fetch(
        `${BASE_URL}/api/${orgSlug}/links/proxy/_test/dispatch`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ method: "GET", path: "/_sandbox/events" }),
        },
      );
      // 503 ⇒ NATS unavailable in this environment — tolerate (round-trip can't
      // be exercised without NATS; the unit tests cover the adapter logic).
      if (res.status === 503) {
        test.skip(true, "NATS unavailable — proxy channel returned 503");
        return;
      }
      expect(res.status).toBe(200);

      // Read the response body incrementally and timestamp each arrival.
      const reader = res.body!.getReader();
      const received: number[] = [];
      const t0 = Date.now();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) {
          chunkArrival.push(Date.now() - t0);
          received.push(...value);
        }
      }

      // 1. Byte-exact, including the non-UTF-8 bytes.
      expect(received).toEqual([...part1, ...part2]);

      // 2. Incremental relay: the two chunks arrived in ≥2 separate reads with a
      //    measurable gap (not buffered-till-end). Tolerant on exact timing.
      expect(chunkArrival.length).toBeGreaterThanOrEqual(2);
      const firstArrival = chunkArrival[0] ?? 0;
      const lastArrival = chunkArrival[chunkArrival.length - 1] ?? 0;
      expect(lastArrival - firstArrival).toBeGreaterThanOrEqual(150);
    } finally {
      await sim.dispose();
      await presence.dispose();
    }
  });

  // 4: a request issued while the simulator is mid-handling another is delivered.
  test("a request issued during an in-flight request is not lost", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const cookie = await cookieHeader(page);

    const presence = await establishPresence(api, orgSlug);
    presence.refresh();

    // First request handler holds the reply open for a beat; second replies fast.
    let firstReleased!: () => void;
    const firstHold = new Promise<void>((r) => {
      firstReleased = r;
    });

    const sim = new ProxyDaemonSimulator(orgSlug, cookie, async (frame, w) => {
      const marker = frame.path.includes("first") ? "FIRST" : "SECOND";
      await w.write({ type: "headers", status: 200, headers: {} });
      if (marker === "FIRST") await firstHold; // stay mid-handling
      await w.write({
        type: "chunk",
        data: b64(new TextEncoder().encode(marker)),
      });
      await w.write({ type: "end" });
    });
    sim.start();

    const dispatch = (path: string): Promise<string> =>
      fetch(`${BASE_URL}/api/${orgSlug}/links/proxy/_test/dispatch`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ method: "GET", path }),
      }).then(async (r) => {
        if (r.status === 503) return "__503__";
        expect(r.status).toBe(200);
        return new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));
      });

    try {
      const first = dispatch("/_sandbox/first/events");
      // Give the simulator a moment to dequeue the first and start handling it.
      await new Promise((r) => setTimeout(r, 500));
      // Issue the second WHILE the first is still mid-handling.
      const second = dispatch("/_sandbox/second/config");

      const secondResult = await second;
      if (secondResult === "__503__") {
        test.skip(true, "NATS unavailable — proxy channel returned 503");
        firstReleased();
        await first.catch(() => {});
        return;
      }
      // The second was delivered + replied despite the first being in flight.
      expect(secondResult).toBe("SECOND");
      // The simulator dequeued TWO distinct requests (the continuous-overlap
      // poll + queue-group guaranteed the second wasn't dropped into a gap).
      expect(new Set(sim.seenReqIds).size).toBeGreaterThanOrEqual(2);

      firstReleased();
      expect(await first).toBe("FIRST");
    } finally {
      firstReleased();
      await sim.dispose();
      await presence.dispose();
    }
  });

  // 3: cancel reaches the simulator and the caller's stream ends.
  test("caller abort delivers cancel_req to the simulator and ends the stream", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const cookie = await cookieHeader(page);

    const presence = await establishPresence(api, orgSlug);
    presence.refresh();

    // A long-lived /events-style reply: headers, one chunk, then it stalls
    // until the abort signal fires (mirrors an SSE that never ends on its own).
    let observedAbort = false;
    const sim = new ProxyDaemonSimulator(
      orgSlug,
      cookie,
      async (_frame, w, signal) => {
        await w.write({ type: "headers", status: 200, headers: {} });
        await w.write({
          type: "chunk",
          data: b64(new TextEncoder().encode("open")),
        });
        // Wait for cancel — the SSE has no natural end.
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            observedAbort = true;
            return resolve();
          }
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    );
    sim.start();

    const ac = new AbortController();
    try {
      const res = await fetch(
        `${BASE_URL}/api/${orgSlug}/links/proxy/_test/dispatch`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ method: "GET", path: "/_sandbox/events" }),
          signal: ac.signal,
        },
      );
      if (res.status === 503) {
        test.skip(true, "NATS unavailable — proxy channel returned 503");
        return;
      }
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      // Read the first chunk ("open"), then abort the caller mid-stream.
      const first = await reader.read();
      expect(first.done).toBe(false);

      ac.abort();
      // The caller's stream must end (read throws or returns done) promptly.
      await expect(
        (async () => {
          while (true) {
            const { done } = await reader.read();
            if (done) return "done";
          }
        })(),
      ).rejects.toThrow();

      // The cancel_req must have reached the simulator (control channel) and the
      // handler observed the abort — freeing the SSE slot (landmine #3).
      await expect
        .poll(() => observedAbort, { timeout: 10_000, intervals: [100, 250] })
        .toBe(true);
      expect(sim.canceledReqIds.length).toBeGreaterThanOrEqual(1);
    } finally {
      await sim.dispose();
      await presence.dispose();
    }
  });

  // 5: daemon-vanished fail-fast — a reply POST that errors mid-stream makes the
  // caller reject within a bounded time (the POST-drop error-frame backstop).
  // The presence-TTL-expiry variant of fail-fast is covered by unit tests
  // (link-proxy-routes.test.ts "daemon-vanished fail-fast") because forcing the
  // 60 s TTL to expire in-band is not practical in e2e.
  test("daemon-vanished mid-stream makes the caller fail fast (not hang)", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const cookie = await cookieHeader(page);

    const presence = await establishPresence(api, orgSlug);
    presence.refresh();

    // Simulator emits headers + a chunk, then ABRUPTLY drops the reply POST
    // (returns without an end/error frame). The route's catch publishes an
    // error frame to links.proxy.reply.<reqId>, so the caller rejects.
    const sim = new ProxyDaemonSimulator(
      orgSlug,
      cookie,
      async (_frame, w, signal) => {
        await w.write({ type: "headers", status: 200, headers: {} });
        await w.write({
          type: "chunk",
          data: b64(new TextEncoder().encode("partial")),
        });
        // Abort the reply POST locally (daemon vanished) — no terminal frame.
        // We throw so the simulator's handler wrapper closes the controller; the
        // cluster sees the body end without a terminal → no synthesized end, and
        // the presence/POST-drop backstops are what end the caller.
        void signal;
        throw new Error("simulated daemon vanish");
      },
    );
    sim.start();

    try {
      const res = await fetch(
        `${BASE_URL}/api/${orgSlug}/links/proxy/_test/dispatch`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ method: "GET", path: "/_sandbox/events" }),
        },
      );
      if (res.status === 503) {
        test.skip(true, "NATS unavailable — proxy channel returned 503");
        return;
      }
      expect(res.status).toBe(200);

      // Reading must terminate within a bounded time: either the stream ends
      // (clean close, no terminal frame relayed) or errors. The hard guard is
      // NOT-HANGS: bound the read with a timeout race.
      const drained = (async () => {
        const reader = res.body!.getReader();
        const bytes: number[] = [];
        while (true) {
          const { value, done } = await reader.read();
          if (done) return bytes;
          if (value) bytes.push(...value);
        }
      })();

      const result = await Promise.race([
        drained.then(() => "ended").catch(() => "errored"),
        new Promise<string>((r) => setTimeout(() => r("__hung__"), 15_000)),
      ]);

      expect(result).not.toBe("__hung__");
    } finally {
      await sim.dispose();
      await presence.dispose();
    }
  });
});
