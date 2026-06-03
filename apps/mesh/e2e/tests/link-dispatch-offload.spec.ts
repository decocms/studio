/**
 * E2E: link dispatch message-offload-by-reference.
 *
 * Exercises the cluster `remoteDispatch` ↔ daemon `handleDispatchRequest`
 * seam for oversized dispatch bodies. When `input.messages` would blow the
 * NATS per-message budget (`MAX_PUBLISH_BYTES`, 768 KiB), the cluster PUTs the
 * messages JSON to object storage and sends a small `{ messagesRef }` envelope;
 * the daemon re-inflates by fetching the presigned URL — but ONLY if the URL's
 * host is in its `allowedHosts` SSRF allowlist (sourced from trusted daemon
 * boot config, never the request frame).
 *
 * Rather than spawn a real sandbox-daemon binary (not available in the e2e
 * harness — see link-dispatch-happy.spec.ts), we wire the cluster's
 * `proxyDaemonRequest` directly into the real `handleDispatchRequest` over an
 * in-process loopback. Both sides run their REAL code: the offload encode +
 * capability gate (`remoteDispatch`), the offload PUT/GET/DELETE against real
 * MinIO, the SSRF allowlist + re-inflate + error framing (the daemon route).
 * Only the harness itself and the transport hop are stand-ins.
 *
 * Storage-independent cases (pre-body error, no-capability, SSRF off-allowlist,
 * no-storage) always run. The full happy-path roundtrip (object appears then is
 * deleted on completion) needs a real fetchable object store and is skipped
 * when S3 isn't configured (plain local `bun run test:e2e`); CI's e2.yml stands
 * up MinIO so it runs there.
 */

import { expect, test } from "../fixtures/test";
import {
  handleDispatchRequest,
  resetDispatchStateForTests,
  type DispatchHarness,
} from "@decocms/sandbox/daemon/routes/dispatch";
import {
  remoteDispatch,
  type RemoteDispatchDeps,
} from "../../src/harnesses/remote-dispatch";
import {
  offloadKey,
  sha256Hex,
  type MessagesRef,
} from "../../src/harnesses/offload-messages";
import { MAX_PUBLISH_BYTES } from "../../src/nats/payload-chunking";
import { FIXTURE_MINIMAL_INPUT } from "../../src/links/protocol/fixtures";
import type { HarnessStreamInput } from "../../src/harnesses/types";
import { S3Service } from "../../src/object-storage/s3-service";
import type { UIMessageChunk } from "ai";

const DAEMON_TOKEN = "offload-e2e-daemon-token";
const HANDLE = "offload-e2e-handle";

const s3Configured = !!(
  process.env.S3_ENDPOINT &&
  process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY
);

/** Build a real S3Service from the e2e env (CI points it at MinIO). */
function buildS3(): S3Service {
  return new S3Service({
    endpoint: process.env.S3_ENDPOINT!,
    bucket: process.env.S3_BUCKET!,
    region: process.env.S3_REGION || "auto",
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    forcePathStyle:
      process.env.S3_FORCE_PATH_STYLE === undefined ||
      process.env.S3_FORCE_PATH_STYLE === "" ||
      process.env.S3_FORCE_PATH_STYLE === "true" ||
      process.env.S3_FORCE_PATH_STYLE === "1",
  });
}

/** A harness input whose serialized body exceeds MAX_PUBLISH_BYTES so the
 *  cluster's `shouldOffload` fires. The big string lives in a single opaque
 *  message (the link protocol treats messages as opaque records). */
function oversizedInput(): HarnessStreamInput {
  const big = "x".repeat(MAX_PUBLISH_BYTES + 64 * 1024);
  return {
    ...FIXTURE_MINIMAL_INPUT,
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    messages: [{ role: "user", content: big }],
  } as unknown as HarnessStreamInput;
}

/** A harness that echoes a couple of text chunks then completes. Stands in for
 *  the real CLI harness — the dispatch route only needs an AsyncIterable. */
function fakeHarness(): DispatchHarness {
  return {
    async *stream() {
      yield { type: "text-start", id: "t1" };
      yield { type: "text-delta", id: "t1", delta: "ok" };
      yield { type: "text-end", id: "t1" };
    },
  };
}

/**
 * Wire the cluster's `proxyDaemonRequest` straight into the daemon's real
 * `handleDispatchRequest`. `daemonAllowedHosts` / `daemonAllowSameHostDev`
 * model the daemon boot config (`OFFLOAD_ALLOWED_HOSTS` /
 * `OFFLOAD_ALLOW_SAME_HOST_DEV`) — i.e. exactly what Part A's wiring threads
 * from the cluster into the spawned daemon's env.
 */
function clusterToDaemonProxy(opts: {
  daemonAllowedHosts: string[];
  daemonAllowSameHostDev: boolean;
  harness?: DispatchHarness;
  /** Override the response entirely (used for the pre-body error case). */
  override?: () => Promise<Response>;
}): RemoteDispatchDeps["proxyDaemonRequest"] {
  return async (_handle, _path, init) => {
    if (opts.override) return opts.override();
    const req = new Request("http://127.0.0.1/_sandbox/dispatch", {
      method: init.method,
      headers: { ...init.headers, authorization: `Bearer ${DAEMON_TOKEN}` },
      body: init.body,
    });
    return handleDispatchRequest(req, {
      daemonToken: DAEMON_TOKEN,
      lookupHarness: () => opts.harness ?? fakeHarness(),
      allowedHosts: opts.daemonAllowedHosts,
      allowSameHostDev: opts.daemonAllowSameHostDev,
    });
  };
}

/** Drain a remoteDispatch stream into an array of chunks (or throw). */
async function drain(
  iter: AsyncIterable<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

test.describe("link dispatch message-offload", () => {
  test.beforeEach(() => {
    // The dispatch route keeps module-scoped activeRuns/tombstones maps.
    resetDispatchStateForTests();
  });

  // ── Case 1: oversized body roundtrips through real object storage ───────
  // Needs a real fetchable store (MinIO). The object must appear under
  // `link-dispatch/` during the run and be deleted on clean completion.
  test("oversized dispatch offloads to storage, runs, and cleans up", async () => {
    test.skip(
      !s3Configured,
      "requires S3 env (MinIO) for a fetchable offload URL; see e2e.yml",
    );

    const s3 = buildS3();
    const orgId = `org-offload-e2e-${Date.now()}`;
    const seenKeys: string[] = [];

    const offload: NonNullable<RemoteDispatchDeps["offload"]> = {
      supported: true,
      put: async (reqId, messagesJson) => {
        const bytes = new TextEncoder().encode(messagesJson);
        const key = offloadKey(reqId);
        await s3.put(orgId, key, bytes, { contentType: "application/json" });
        seenKeys.push(key);
        const url = await s3.presignedGetUrl(orgId, key, 600, {
          requireFetchable: true,
        });
        return {
          url,
          bytes: bytes.byteLength,
          sha256: await sha256Hex(bytes),
        } satisfies MessagesRef;
      },
      cleanup: (key) => s3.delete(orgId, key),
    };

    const input = oversizedInput();
    const chunks = await drain(
      remoteDispatch("claude-code", input, HANDLE, {
        proxyDaemonRequest: clusterToDaemonProxy({
          // localhost MinIO over http — the daemon must allow loopback in dev.
          daemonAllowedHosts: [new URL(process.env.S3_ENDPOINT!).hostname],
          daemonAllowSameHostDev: true,
        }),
        offload,
      }),
    );

    // Run completed: the fake harness's chunks made it back through the SSE
    // reassembly intact (no silent-empty-stream).
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.type === "text-delta")).toBe(true);

    // The offload object was actually written.
    expect(seenKeys.length).toBe(1);

    // …and deleted on clean completion (cleanup fires post-drain). HEAD must
    // now fail closed. Poll briefly since cleanup is fire-and-forget.
    await expect
      .poll(
        async () => {
          try {
            await s3.head(orgId, seenKeys[0]!);
            return "present";
          } catch {
            return "gone";
          }
        },
        { timeout: 5_000, intervals: [200, 500] },
      )
      .toBe("gone");
  });

  // ── Case 2: pre-body dispatch error → run fails with a real message ─────
  // A non-2xx Response carries no SSE `data:` lines; feeding it to the parser
  // would silently yield an empty stream (a failed run that looks successful).
  // remoteDispatch must read the JSON error and THROW. Guards that regression.
  test("pre-body dispatch error rejects loudly (no silent empty stream)", async () => {
    const proxy = clusterToDaemonProxy({
      daemonAllowedHosts: [],
      daemonAllowSameHostDev: false,
      override: async () =>
        new Response(JSON.stringify({ error: "boom_before_stream" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });

    // Small body — no offload, takes the synchronous dispatch path.
    const input = {
      ...FIXTURE_MINIMAL_INPUT,
      runId: `run-${Date.now()}`,
    } as unknown as HarnessStreamInput;

    await expect(
      drain(
        remoteDispatch("claude-code", input, HANDLE, {
          proxyDaemonRequest: proxy,
        }),
      ),
    ).rejects.toThrow(/boom_before_stream/);
  });

  // ── Case 3: no body-offload capability + oversized body → clean error ───
  // When the daemon doesn't advertise `body-offload`, an oversized body is a
  // hard error BEFORE any request is sent — never a silently-truncated body.
  test("oversized body without body-offload capability fails before dispatch", async () => {
    let proxyCalled = false;
    const offload: NonNullable<RemoteDispatchDeps["offload"]> = {
      supported: false, // daemon too old / capability absent
      put: async () => {
        throw new Error("put must not be called when unsupported");
      },
      cleanup: async () => {},
    };

    await expect(
      drain(
        remoteDispatch("claude-code", oversizedInput(), HANDLE, {
          proxyDaemonRequest: async () => {
            proxyCalled = true;
            return new Response(null, { status: 200 });
          },
          offload,
        }),
      ),
    ).rejects.toThrow(/too large|cannot receive offloaded/i);

    // The hard stop happened before any wire send — no empty/truncated body.
    expect(proxyCalled).toBe(false);
  });

  // ── Case 4: SSRF — messagesRef host off the allowlist → offload_fetch_failed
  // The offloaded ref points at a host the daemon's allowlist does NOT include.
  // The daemon must refuse to fetch it and frame `offload_fetch_failed`, which
  // remoteDispatch surfaces as a throw. No real storage needed: the put returns
  // a ref to a disallowed host directly.
  test("offload ref to a non-allowlisted host fails closed (SSRF guard)", async () => {
    const offload: NonNullable<RemoteDispatchDeps["offload"]> = {
      supported: true,
      put: async (_reqId, messagesJson) => {
        const bytes = new TextEncoder().encode(messagesJson);
        return {
          // Host the daemon does NOT allow.
          url: "https://evil.attacker.example.com/link-dispatch/leak",
          bytes: bytes.byteLength,
          sha256: await sha256Hex(bytes),
        } satisfies MessagesRef;
      },
      cleanup: async () => {},
    };

    await expect(
      drain(
        remoteDispatch("claude-code", oversizedInput(), HANDLE, {
          proxyDaemonRequest: clusterToDaemonProxy({
            // Allowlist deliberately excludes the ref's host.
            daemonAllowedHosts: ["storage.trusted.example.com"],
            daemonAllowSameHostDev: false,
          }),
          offload,
        }),
      ),
    ).rejects.toThrow(/offload_fetch_failed|host not allowed/i);
  });

  // ── Case 5: no real storage + oversized body → clean error ──────────────
  // Mirrors dispatch-run.ts's `ctx.objectStorage == null` branch: offload is a
  // hard "no" (`supported:false`, put throws). An oversized body must fail
  // loudly rather than send an empty body.
  test("oversized body with no object storage configured fails cleanly", async () => {
    let proxyCalled = false;
    // The exact shape dispatch-run builds when ctx.objectStorage is null.
    const offload: NonNullable<RemoteDispatchDeps["offload"]> = {
      supported: false,
      put: async () => {
        throw new Error("no object storage");
      },
      cleanup: async () => {},
    };

    await expect(
      drain(
        remoteDispatch("claude-code", oversizedInput(), HANDLE, {
          proxyDaemonRequest: async () => {
            proxyCalled = true;
            return new Response(null, { status: 200 });
          },
          offload,
        }),
      ),
    ).rejects.toThrow(/too large|cannot receive offloaded/i);
    expect(proxyCalled).toBe(false);
  });
});
