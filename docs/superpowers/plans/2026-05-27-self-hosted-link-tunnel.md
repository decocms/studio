# Self-Hosted Link Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloudflare-hosted Warp tunnel with an authenticated WebSocket between `deco link` daemons and the mesh cluster, with NATS subject routing for cross-pod dispatch and a local `<handle>.localhost` ingress on the daemon for sandbox previews.

**Architecture:** Daemon opens an authenticated WebSocket to `wss://<cluster>/api/links/connect`. The pod that owns the WS claims ownership in a NATS JetStream KV bucket (`studio_links`) and subscribes to `links.dispatch.<userSub>`. Any mesh pod calls `dispatchToDaemon(userSub, req)` which becomes a NATS request to that subject; the owner pod forwards the request over the WS and streams chunks back. Sandbox previews are served locally at `http://<handle>.localhost:<daemon-port>/` — no public URLs, no wildcard DNS.

**Tech Stack:** Bun, Hono, Better Auth (sessions), NATS (`nats` package, JetStream KV), Kysely (Postgres migrations), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-05-27-self-hosted-link-tunnel-design.md`

---

## File Structure

### New files (mesh side)

- `apps/mesh/src/links/dispatch-frames.ts` — Frame types + Zod schemas + codec for the daemon↔mesh WS protocol.
- `apps/mesh/src/links/dispatch-frames.test.ts`
- `apps/mesh/src/links/link-claim-registry.ts` — NATS JS KV bucket (`studio_links`) operations: `get`, `put`, `delete`, `watch`.
- `apps/mesh/src/links/link-claim-registry.test.ts` (uses `createInMemoryLinkClaimRegistry`)
- `apps/mesh/src/links/ws-gateway.ts` — `GET /api/links/connect` handler. Validates Better Auth bearer, upgrades to WebSocket, awaits hello, claims KV, subscribes NATS subjects, demuxes frames.
- `apps/mesh/src/links/ws-gateway.test.ts`
- `apps/mesh/src/links/dispatcher.ts` — `dispatchToDaemon(userSub, req): AsyncIterable<DispatchChunk>` (NATS request with streamed inbox).
- `apps/mesh/src/links/dispatcher.test.ts`
- `apps/mesh/migrations/097-drop-link-registry.ts` — drops the `link_registry` table.

### New files (daemon side)

- `apps/mesh/src/link-daemon/host-parser.ts` — `parseHandleFromHost("<handle>.localhost:5174") => "<handle>"`.
- `apps/mesh/src/link-daemon/host-parser.test.ts`
- `apps/mesh/src/link-daemon/reconnect-backoff.ts` — exponential backoff with jitter; close-code policy.
- `apps/mesh/src/link-daemon/reconnect-backoff.test.ts`
- `apps/mesh/src/link-daemon/cluster-connection.ts` — open WS to mesh, send hello, demux `request`/`cancel` frames into in-process handlers, stream responses back.
- `apps/mesh/src/link-daemon/cluster-connection.test.ts`
- `apps/mesh/src/link-daemon/control-handler.ts` — In-process replacement for `control-plane.ts`'s sandbox routes (POST `/api/sandboxes`, DELETE `/api/sandboxes/<handle>`). Pure async functions, no HTTP, no HMAC.
- `apps/mesh/src/link-daemon/control-handler.test.ts`
- `apps/mesh/src/link-daemon/local-ingress.ts` — `Bun.serve` listening on the configurable port; routes `<handle>.localhost` by Host header; HTTP and WebSocket reverse proxy to the sandbox's local port.
- `apps/mesh/src/link-daemon/local-ingress.test.ts`

### Modified files

- `apps/mesh/src/links/protocol/schemas.ts` — Remove `tunnelUrl` from `linkEntrySchema` and `registrationPayloadSchema`. Remove `linkSecret` from `linkEntrySchema` and `registrationResponseSchema` (or delete `registrationResponseSchema` entirely). Add the new `helloPayloadSchema` (`previewPort` field replaces `tunnelUrl`).
- `apps/mesh/src/links/protocol/index.ts` — Drop the HMAC re-exports; add the new `dispatch-frames` exports.
- `apps/mesh/src/api/app.ts` — Replace `registerLinksRoutes(app, …)` call with `registerLinksGateway(app, …)`. Drop `allowLocalhostLinks` arg.
- `apps/mesh/src/harnesses/remote-dispatch.ts` — Rewrite to consume `dispatchToDaemon` instead of building tunnel URLs and HMAC-signing HTTP requests. Delete `parseSSEStream`, `extractEvents`, `handleEvent`, `RemoteDispatchLink`. `remoteDispatch(id, input, userSub)` is the new shape.
- `apps/mesh/src/sandbox/lifecycle.ts:202` — Drop the `link: { tunnelUrl, linkSecret }` argument. The desktop provider on the cluster side gets the userSub from `link.userId`.
- `apps/mesh/src/tools/sandbox/start.ts:383` — Replace `sandboxApiUrl: sandbox.previewUrl` plumbing with passing the `userSub` through to whatever consumes the result. (Detailed in task 11.)
- `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` — Use `dispatchToDaemon` for the remote-cli path.
- `apps/mesh/src/link-daemon/index.ts` — Rewire `startLinkDaemon` to use `cluster-connection` + `local-ingress`. Remove `openTunnel`, `registerWithCluster`, `startHeartbeatLoop`, `makeControlPlaneHandler`, all HMAC plumbing, `noTunnel` branching, `linkSecret` handling.
- `apps/mesh/src/link-daemon/user-desktop-provider.ts` — Delete `openDaemonTunnel` from `DesktopSandboxProviderDeps`; remove `tunnel` field from `SandboxState`; remove all `tunnel?.close()` / `subDomain` / `publicUrl` references. `sandboxApiUrl` becomes derived (`http://127.0.0.1:<port>`).
- `apps/mesh/src/cli.ts` — Remove `--no-tunnel` flag; remove from help text.
- `apps/mesh/src/cli/commands/link.ts` — Remove `noTunnel` from `LinkCommandOptions` and from `runLinkCommand`.
- `apps/mesh/package.json` — Remove `@deco-cx/warp-node` dependency.

### Deleted files

- `apps/mesh/src/link-daemon/tunnel.ts` + `tunnel.test.ts`
- `apps/mesh/src/link-daemon/registration.ts` (no test file exists)
- `apps/mesh/src/link-daemon/control-plane.ts` + `control-plane.test.ts` (logic moves to `control-handler.ts`)
- `apps/mesh/src/links/routes.ts` + `routes.test.ts` (replaced by `ws-gateway.ts`)
- `apps/mesh/src/links/link-registry.ts` + `link-registry.test.ts` (replaced by `link-claim-registry.ts`)
- `apps/mesh/src/links/protocol/hmac.ts` + `hmac.test.ts`
- `apps/mesh/src/links/protocol/fixtures.ts` (HMAC-only fixtures)
- `apps/mesh/src/links/loopback.test.ts` + `dispatch-loopback.test.ts` + `resolve-dispatch-target.test.ts` + `cancellation.test.ts` (all assume old tunnel + HMAC; rewrite as e2e in tasks 18–21)

### New e2e files

- `apps/mesh/e2e/tests/link-dispatch-happy.spec.ts`
- `apps/mesh/e2e/tests/link-dispatch-eviction.spec.ts`
- `apps/mesh/e2e/tests/link-dispatch-auth.spec.ts`
- `apps/mesh/e2e/tests/link-local-ingress.spec.ts`

### New resilience scenarios

- `tests/resilience/scenarios/link-dispatch-nats-disconnect.test.ts`
- `tests/resilience/scenarios/link-dispatch-pod-crash.test.ts`

---

## Branch and commits

Already on branch `tlgimenes/decocms-link-warp-tunnel`. Each task ends with a commit (frequent commits per the writing-plans skill); the implementer should not amend prior commits.

---

## Task 1: Dispatch frame codec

**Files:**
- Create: `apps/mesh/src/links/dispatch-frames.ts`
- Test: `apps/mesh/src/links/dispatch-frames.test.ts`

The frame protocol carries multiplexed HTTP-style requests over a single WebSocket. Frame types and shape are exactly as in the spec §2 / §4 update.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/links/dispatch-frames.test.ts
import { describe, expect, test } from "bun:test";
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "./dispatch-frames";

describe("dispatch-frames codec", () => {
  test("round-trips a hello frame", () => {
    const frame: DispatchFrame = {
      type: "hello",
      previewPort: 5174,
      machineId: "m-abc",
      hostname: "laptop.local",
      cliVersion: "1.2.3",
      capabilities: ["decopilot-sandbox"],
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test("round-trips a request frame", () => {
    const frame: DispatchFrame = {
      type: "request",
      reqId: "r-1",
      method: "POST",
      path: "/_sandbox/dispatch",
      headers: { "content-type": "application/json" },
      body: '{"x":1}',
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test("round-trips a chunk frame", () => {
    const frame: DispatchFrame = { type: "chunk", reqId: "r-1", data: "hello" };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test("round-trips end and error frames", () => {
    const end: DispatchFrame = { type: "end", reqId: "r-1" };
    expect(decodeFrame(encodeFrame(end))).toEqual(end);
    const err: DispatchFrame = {
      type: "error",
      reqId: "r-1",
      code: "BOOM",
      message: "kaboom",
    };
    expect(decodeFrame(encodeFrame(err))).toEqual(err);
  });

  test("round-trips a cancel frame", () => {
    const frame: DispatchFrame = { type: "cancel", reqId: "r-1" };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test("rejects unknown type", () => {
    expect(() => decodeFrame('{"type":"nope","reqId":"r-1"}')).toThrow(
      /unknown frame type/i,
    );
  });

  test("rejects missing reqId on non-hello frames", () => {
    expect(() => decodeFrame('{"type":"chunk","data":"x"}')).toThrow();
  });

  test("rejects malformed JSON", () => {
    expect(() => decodeFrame("not-json")).toThrow();
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test apps/mesh/src/links/dispatch-frames.test.ts`
Expected: FAIL — `Cannot find module "./dispatch-frames"`.

- [ ] **Step 3: Implement the codec**

```ts
// apps/mesh/src/links/dispatch-frames.ts
/**
 * Frame protocol for the daemon ↔ mesh-pod WebSocket. Frames are JSON
 * text-frames over a single WS, multiplexed by `reqId`. The `hello` frame is
 * the only one without a reqId — it's the one-shot handshake.
 */
import { z } from "zod";

const helloFrame = z.object({
  type: z.literal("hello"),
  previewPort: z.number().int().min(1).max(65535),
  machineId: z.string().min(1),
  hostname: z.string().optional(),
  cliVersion: z.string().min(1),
  capabilities: z.array(z.string()),
});

const requestFrame = z.object({
  type: z.literal("request"),
  reqId: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string()),
  body: z.string().optional(),
});

const cancelFrame = z.object({
  type: z.literal("cancel"),
  reqId: z.string().min(1),
});

const headersFrame = z.object({
  type: z.literal("headers"),
  reqId: z.string().min(1),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string()),
});

const chunkFrame = z.object({
  type: z.literal("chunk"),
  reqId: z.string().min(1),
  data: z.string(),
});

const endFrame = z.object({
  type: z.literal("end"),
  reqId: z.string().min(1),
});

const errorFrame = z.object({
  type: z.literal("error"),
  reqId: z.string().min(1),
  code: z.string().min(1),
  message: z.string(),
});

export const dispatchFrameSchema = z.discriminatedUnion("type", [
  helloFrame,
  requestFrame,
  cancelFrame,
  headersFrame,
  chunkFrame,
  endFrame,
  errorFrame,
]);

export type HelloFrame = z.infer<typeof helloFrame>;
export type RequestFrame = z.infer<typeof requestFrame>;
export type CancelFrame = z.infer<typeof cancelFrame>;
export type HeadersFrame = z.infer<typeof headersFrame>;
export type ChunkFrame = z.infer<typeof chunkFrame>;
export type EndFrame = z.infer<typeof endFrame>;
export type ErrorFrame = z.infer<typeof errorFrame>;
export type DispatchFrame = z.infer<typeof dispatchFrameSchema>;

export function encodeFrame(frame: DispatchFrame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(text: string): DispatchFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("dispatch-frames: malformed JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("dispatch-frames: frame must be an object");
  }
  const type = (raw as { type?: unknown }).type;
  if (
    typeof type !== "string" ||
    ![
      "hello",
      "request",
      "cancel",
      "headers",
      "chunk",
      "end",
      "error",
    ].includes(type)
  ) {
    throw new Error(`dispatch-frames: unknown frame type "${String(type)}"`);
  }
  const parsed = dispatchFrameSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`dispatch-frames: ${parsed.error.message}`);
  }
  return parsed.data;
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `bun test apps/mesh/src/links/dispatch-frames.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/links/dispatch-frames.ts apps/mesh/src/links/dispatch-frames.test.ts
git commit -m "feat(links): add dispatch frame codec for daemon↔mesh WS"
```

---

## Task 2: Host header parser for local ingress

**Files:**
- Create: `apps/mesh/src/link-daemon/host-parser.ts`
- Test: `apps/mesh/src/link-daemon/host-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/link-daemon/host-parser.test.ts
import { describe, expect, test } from "bun:test";
import { parseHandleFromHost } from "./host-parser";

describe("parseHandleFromHost", () => {
  test("extracts handle with explicit port", () => {
    expect(parseHandleFromHost("abc123.localhost:5174")).toBe("abc123");
  });

  test("extracts handle with no port", () => {
    expect(parseHandleFromHost("abc123.localhost")).toBe("abc123");
  });

  test("lowercases the handle", () => {
    expect(parseHandleFromHost("ABC123.localhost:5174")).toBe("abc123");
  });

  test("trims trailing dot in host", () => {
    expect(parseHandleFromHost("abc.localhost.:5174")).toBe("abc");
  });

  test("rejects bare localhost (no handle)", () => {
    expect(parseHandleFromHost("localhost:5174")).toBeNull();
    expect(parseHandleFromHost("localhost")).toBeNull();
  });

  test("rejects non-localhost hosts", () => {
    expect(parseHandleFromHost("abc.example.com:5174")).toBeNull();
    expect(parseHandleFromHost("evil.com")).toBeNull();
  });

  test("rejects empty and undefined input", () => {
    expect(parseHandleFromHost("")).toBeNull();
    expect(parseHandleFromHost(null)).toBeNull();
    expect(parseHandleFromHost(undefined)).toBeNull();
  });

  test("rejects IPv6 hosts", () => {
    expect(parseHandleFromHost("[::1]:5174")).toBeNull();
  });

  test("rejects handles with dots inside", () => {
    // Multi-level subdomains aren't supported — handle must be a single
    // label directly under .localhost.
    expect(parseHandleFromHost("a.b.localhost:5174")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test apps/mesh/src/link-daemon/host-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

```ts
// apps/mesh/src/link-daemon/host-parser.ts
/**
 * Pull the sandbox `<handle>` out of an HTTP Host header for the local
 * ingress. The daemon serves `<handle>.localhost[:port]` and proxies to the
 * sandbox keyed by handle. Anything else (bare `localhost`, public hostnames,
 * multi-level subdomains, IPv6, empty) returns null so the ingress can 404.
 */
export function parseHandleFromHost(
  host: string | null | undefined,
): string | null {
  if (typeof host !== "string" || host.length === 0) return null;

  // Strip port.
  const colon = host.lastIndexOf(":");
  // IPv6 literals are `[::1]:port` — bracketed. Reject them outright; the
  // local ingress is `*.localhost` only.
  if (host.startsWith("[")) return null;
  const hostname = colon >= 0 ? host.slice(0, colon) : host;

  // Strip trailing dot (FQDN form).
  const normalized = hostname.replace(/\.$/, "").toLowerCase();

  // Must end in ".localhost" and have exactly one extra label.
  const suffix = ".localhost";
  if (!normalized.endsWith(suffix)) return null;
  const handle = normalized.slice(0, -suffix.length);
  if (handle.length === 0) return null; // bare "localhost"
  if (handle.includes(".")) return null; // multi-level subdomain

  return handle;
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `bun test apps/mesh/src/link-daemon/host-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/host-parser.ts apps/mesh/src/link-daemon/host-parser.test.ts
git commit -m "feat(link-daemon): add host parser for local ingress routing"
```

---

## Task 3: WS reconnect backoff

**Files:**
- Create: `apps/mesh/src/link-daemon/reconnect-backoff.ts`
- Test: `apps/mesh/src/link-daemon/reconnect-backoff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/link-daemon/reconnect-backoff.test.ts
import { describe, expect, test } from "bun:test";
import {
  computeBackoffMs,
  shouldReconnectOnClose,
  WS_CLOSE_SUPERSEDED,
} from "./reconnect-backoff";

describe("computeBackoffMs", () => {
  test("first attempt is ~base (500ms ± jitter)", () => {
    const ms = computeBackoffMs(1);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThanOrEqual(500);
  });

  test("grows exponentially", () => {
    expect(computeBackoffMs(2)).toBeLessThanOrEqual(1_000);
    expect(computeBackoffMs(2)).toBeGreaterThanOrEqual(500);
    expect(computeBackoffMs(3)).toBeLessThanOrEqual(2_000);
  });

  test("caps at 30s", () => {
    expect(computeBackoffMs(20)).toBeLessThanOrEqual(30_000);
    expect(computeBackoffMs(20)).toBeGreaterThanOrEqual(15_000);
  });

  test("attempt 0 throws (we count from 1)", () => {
    expect(() => computeBackoffMs(0)).toThrow();
  });
});

describe("shouldReconnectOnClose", () => {
  test("returns true for normal disconnects", () => {
    expect(shouldReconnectOnClose(1006)).toBe(true); // abnormal closure
    expect(shouldReconnectOnClose(1001)).toBe(true); // going away
    expect(shouldReconnectOnClose(1011)).toBe(true); // server error
  });

  test("returns true for clean close 1000", () => {
    // Generic 1000 happens on transient drops; reconnect.
    expect(shouldReconnectOnClose(1000)).toBe(true);
  });

  test("returns false for 4001 superseded", () => {
    expect(shouldReconnectOnClose(WS_CLOSE_SUPERSEDED)).toBe(false);
    expect(shouldReconnectOnClose(4001)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test apps/mesh/src/link-daemon/reconnect-backoff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement backoff**

```ts
// apps/mesh/src/link-daemon/reconnect-backoff.ts
/**
 * Reconnect policy for the daemon's WebSocket to mesh. Standard exponential
 * backoff with jitter, capped at 30s. WS close code 4001 means the cluster
 * accepted a newer connection for the same user (last-link-wins) — reconnecting
 * would just oscillate, so we don't.
 */

export const WS_CLOSE_SUPERSEDED = 4001;
const BASE_MS = 500;
const CAP_MS = 30_000;

export function computeBackoffMs(attempt: number): number {
  if (attempt < 1) throw new Error("attempt must be >= 1");
  const exp = Math.min(BASE_MS * 2 ** (attempt - 1), CAP_MS);
  // Full jitter: [exp/2, exp]
  return exp / 2 + Math.random() * (exp / 2);
}

export function shouldReconnectOnClose(code: number): boolean {
  return code !== WS_CLOSE_SUPERSEDED;
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `bun test apps/mesh/src/link-daemon/reconnect-backoff.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/reconnect-backoff.ts apps/mesh/src/link-daemon/reconnect-backoff.test.ts
git commit -m "feat(link-daemon): add WS reconnect backoff with 4001 policy"
```

---

## Task 4: Link claim registry (NATS JetStream KV)

**Files:**
- Create: `apps/mesh/src/links/link-claim-registry.ts`
- Test: `apps/mesh/src/links/link-claim-registry.test.ts`

The claim registry stores `{podId, machineId, previewPort, …}` keyed by `userSub`. It backs the NATS subject routing — only one pod holds a claim at a time, and that's the one that subscribes to `links.dispatch.<userSub>`. Modeled on the existing `link-registry.ts` (which we'll delete in task 16).

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/links/link-claim-registry.test.ts
import { describe, expect, test } from "bun:test";
import {
  createInMemoryLinkClaimRegistry,
  type LinkClaim,
} from "./link-claim-registry";

const sampleClaim: LinkClaim = {
  podId: "pod-A",
  machineId: "m-1",
  hostname: "laptop",
  cliVersion: "1.0.0",
  previewPort: 5174,
  connectedAt: 1_700_000_000_000,
};

describe("link-claim-registry (in-memory)", () => {
  test("returns null when no claim", async () => {
    const r = createInMemoryLinkClaimRegistry();
    expect(await r.get("user-1")).toBeNull();
  });

  test("put then get round-trips the claim", async () => {
    const r = createInMemoryLinkClaimRegistry();
    await r.put("user-1", sampleClaim);
    expect(await r.get("user-1")).toEqual(sampleClaim);
  });

  test("put overwrites prior claim (last-write-wins)", async () => {
    const r = createInMemoryLinkClaimRegistry();
    await r.put("user-1", sampleClaim);
    const next = { ...sampleClaim, podId: "pod-B" };
    await r.put("user-1", next);
    expect(await r.get("user-1")).toEqual(next);
  });

  test("delete removes the claim", async () => {
    const r = createInMemoryLinkClaimRegistry();
    await r.put("user-1", sampleClaim);
    await r.delete("user-1");
    expect(await r.get("user-1")).toBeNull();
  });

  test("watch emits initial value then updates and deletes", async () => {
    const r = createInMemoryLinkClaimRegistry();
    await r.put("user-1", sampleClaim);
    const events: Array<LinkClaim | null> = [];
    const stop = r.watch("user-1", (claim) => events.push(claim));

    // Initial value.
    expect(events).toEqual([sampleClaim]);

    const next = { ...sampleClaim, podId: "pod-B" };
    await r.put("user-1", next);
    expect(events[events.length - 1]).toEqual(next);

    await r.delete("user-1");
    expect(events[events.length - 1]).toBeNull();

    stop();
  });

  test("watch stops emitting after stop()", async () => {
    const r = createInMemoryLinkClaimRegistry();
    const events: Array<LinkClaim | null> = [];
    const stop = r.watch("user-1", (c) => events.push(c));
    stop();
    await r.put("user-1", sampleClaim);
    expect(events).toEqual([null]); // only the initial null
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test apps/mesh/src/links/link-claim-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

```ts
// apps/mesh/src/links/link-claim-registry.ts
/**
 * Claim registry for active daemon WebSockets.
 *
 * Keyed by `userSub`. Stores which mesh pod is currently holding the daemon's
 * WS, plus the daemon's reported preview port so the cluster can build
 * `<handle>.localhost:<previewPort>` URLs. Replaces the older `LinkRegistry`
 * (which stored a `linkSecret` + `tunnelUrl`).
 *
 * Two backends:
 *   - NATS JetStream KV bucket `studio_links` (production). Bucket-level
 *     `maxAge: 60s`. The owning pod refreshes its entry every ~20s.
 *   - In-memory (tests). Same surface, no NATS.
 *
 * The watcher is the eviction mechanism: when a pod sees the entry's `podId`
 * change to something else, it knows it lost ownership and tears down its WS.
 */

import {
  JSONCodec,
  StorageType,
  type JetStreamClient,
  type KV,
} from "nats";

export interface LinkClaim {
  podId: string;
  machineId: string;
  hostname?: string;
  cliVersion: string;
  previewPort: number;
  connectedAt: number;
}

export type ClaimListener = (claim: LinkClaim | null) => void;
export type Unsubscribe = () => void;

export interface LinkClaimRegistry {
  get(userSub: string): Promise<LinkClaim | null>;
  put(userSub: string, claim: LinkClaim): Promise<void>;
  delete(userSub: string): Promise<void>;
  /**
   * Subscribe to claim changes for `userSub`. Fires immediately with the
   * current value (or `null`), then on every put/delete.
   */
  watch(userSub: string, listener: ClaimListener): Unsubscribe;
}

const BUCKET_NAME = "studio_links";
const BUCKET_MAX_AGE_MS = 60_000;

// ── In-memory backend (tests + dev fallback) ──────────────────────────────

export function createInMemoryLinkClaimRegistry(): LinkClaimRegistry {
  const store = new Map<string, LinkClaim>();
  const listeners = new Map<string, Set<ClaimListener>>();

  function fire(userSub: string): void {
    const ls = listeners.get(userSub);
    if (!ls) return;
    const claim = store.get(userSub) ?? null;
    for (const cb of ls) {
      try {
        cb(claim);
      } catch {
        // swallow listener errors
      }
    }
  }

  return {
    async get(userSub) {
      return store.get(userSub) ?? null;
    },
    async put(userSub, claim) {
      store.set(userSub, claim);
      fire(userSub);
    },
    async delete(userSub) {
      store.delete(userSub);
      fire(userSub);
    },
    watch(userSub, listener) {
      let ls = listeners.get(userSub);
      if (!ls) {
        ls = new Set();
        listeners.set(userSub, ls);
      }
      ls.add(listener);
      // initial fire
      try {
        listener(store.get(userSub) ?? null);
      } catch {
        // swallow
      }
      return () => {
        const cur = listeners.get(userSub);
        if (!cur) return;
        cur.delete(listener);
        if (cur.size === 0) listeners.delete(userSub);
      };
    },
  };
}

// ── NATS JS KV backend (production) ────────────────────────────────────────

export interface NatsLinkClaimRegistryOptions {
  getJetStream: () => JetStreamClient | null;
}

export class NatsLinkClaimRegistry implements LinkClaimRegistry {
  private kv: KV | null = null;
  private readonly codec = JSONCodec<LinkClaim>();

  constructor(private readonly options: NatsLinkClaimRegistryOptions) {}

  /** Idempotent. Re-call from `natsProvider.onReady` after a reconnect. */
  async init(): Promise<void> {
    const js = this.options.getJetStream();
    if (!js) return;
    this.kv = await js.views.kv(BUCKET_NAME, {
      history: 1,
      ttl: BUCKET_MAX_AGE_MS,
      storage: StorageType.Memory,
    });
  }

  async get(userSub: string): Promise<LinkClaim | null> {
    if (!this.kv) return null;
    try {
      const entry = await this.kv.get(userSub);
      if (!entry?.value) return null;
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      // Safety net for clusters with looser GC timing.
      const ageMs = Date.now() - entry.created.getTime();
      if (ageMs > BUCKET_MAX_AGE_MS) return null;
      return this.codec.decode(entry.value);
    } catch {
      return null;
    }
  }

  async put(userSub: string, claim: LinkClaim): Promise<void> {
    if (!this.kv) return;
    await this.kv.put(userSub, this.codec.encode(claim));
  }

  async delete(userSub: string): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.delete(userSub);
    } catch {
      // best-effort
    }
  }

  watch(userSub: string, listener: ClaimListener): Unsubscribe {
    if (!this.kv) {
      // No connection yet — fire null and return a no-op.
      try {
        listener(null);
      } catch {
        // swallow
      }
      return () => {};
    }
    let stopped = false;
    let watcher: Awaited<ReturnType<KV["watch"]>> | null = null;
    void (async () => {
      try {
        watcher = await this.kv!.watch({ key: userSub });
        for await (const entry of watcher) {
          if (stopped) return;
          const isDelete =
            entry.operation === "DEL" || entry.operation === "PURGE";
          const claim =
            isDelete || !entry.value ? null : this.codec.decode(entry.value);
          try {
            listener(claim);
          } catch {
            // swallow
          }
        }
      } catch {
        // watch errored — silently stop. Caller will re-watch on reconnect.
      }
    })();
    return () => {
      stopped = true;
      try {
        watcher?.stop();
      } catch {
        // ignore
      }
    };
  }
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `bun test apps/mesh/src/links/link-claim-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/links/link-claim-registry.ts apps/mesh/src/links/link-claim-registry.test.ts
git commit -m "feat(links): add NATS JS KV claim registry"
```

---

## Task 5: Add `helloPayloadSchema` and update protocol exports

**Files:**
- Modify: `apps/mesh/src/links/protocol/schemas.ts`
- Modify: `apps/mesh/src/links/protocol/index.ts`

We'll keep `linkEntrySchema` and `registrationPayloadSchema` around for now (other tasks delete them), but add the new hello payload here so subsequent tasks can import it.

- [ ] **Step 1: Add the new schema**

Append to `apps/mesh/src/links/protocol/schemas.ts` (do NOT remove existing exports yet — task 16 handles that):

```ts
/**
 * `hello` frame payload, sent by the daemon as the first message on the WS
 * after a successful upgrade. Carries the daemon's preview port so the
 * cluster can build `<handle>.localhost:<previewPort>` URLs.
 */
export const helloPayloadSchema = z.object({
  previewPort: z.number().int().min(1).max(65535),
  machineId: z.string().min(1),
  hostname: z.string().optional(),
  cliVersion: z.string().min(1),
  capabilities: z.array(capabilitySchema),
});
export type HelloPayload = z.infer<typeof helloPayloadSchema>;
```

- [ ] **Step 2: Re-export from `index.ts`**

Add to `apps/mesh/src/links/protocol/index.ts` (after existing `export * from "./schemas"`):

```ts
// Already exported via `export * from "./schemas"` — no change needed.
```

(Confirm `schemas.ts` is fully wildcard-exported. If not, add `export type { HelloPayload };` after the existing exports.)

- [ ] **Step 3: Typecheck**

Run: `bun run check`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
bun run fmt
git add apps/mesh/src/links/protocol/schemas.ts apps/mesh/src/links/protocol/index.ts
git commit -m "feat(links): add hello payload schema for WS handshake"
```

---

## Task 6: WS gateway route — accept upgrade, validate auth, await hello, claim

**Files:**
- Create: `apps/mesh/src/links/ws-gateway.ts`
- Test: `apps/mesh/src/links/ws-gateway.test.ts`

Big task. This is the heart of the cluster side. Subagent should read the existing `apps/mesh/src/api/app.ts` to understand the Hono `Env` type and `meshContext` middleware before implementing.

The route does the following:
1. Accept Bun's WebSocket upgrade on `GET /api/links/connect`.
2. Validate the bearer token (Better Auth session resolution).
3. After upgrade, wait up to 5s for the daemon's `hello` frame.
4. Write a claim to the NATS JS KV (this evicts any prior pod).
5. Start watching the claim — if `podId` changes, close the WS with 4001.
6. Subscribe to `links.dispatch.<userSub>` and `links.cancel.<userSub>`.
7. Handle incoming NATS dispatch messages: send a `request` frame, multiplex chunks back on the per-request reply inbox.
8. Refresh the claim every 20s while the WS is open.
9. On WS close (any reason): unsubscribe, stop watch, delete the KV claim (best-effort — if we lost ownership the next owner already overwrote it).

This is too large for one TDD cycle. Split into sub-tasks 6a, 6b, 6c below.

### Task 6a — Auth + upgrade + hello handshake

- [ ] **Step 1: Write the test for the auth + handshake skeleton**

```ts
// apps/mesh/src/links/ws-gateway.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createInMemoryLinkClaimRegistry,
  type LinkClaimRegistry,
} from "./link-claim-registry";
import { registerLinksGateway } from "./ws-gateway";
import { encodeFrame, decodeFrame } from "./dispatch-frames";

// Minimal stand-ins for the gateway's deps.
function makeFakeNatsAdapter() {
  // Records subscribe/publish; doesn't deliver — that's tested in task 6b/6c.
  const subs: string[] = [];
  return {
    subs,
    subscribe: (subject: string) => {
      subs.push(subject);
      return () => {};
    },
    publish: () => {},
    request: async () => null,
  };
}

let server: ReturnType<typeof Bun.serve> | null = null;
let registry: LinkClaimRegistry;

beforeEach(() => {
  registry = createInMemoryLinkClaimRegistry();
});

afterEach(() => {
  server?.stop(true);
  server = null;
});

async function startGateway(opts: {
  validateBearer: (token: string) => Promise<string | null>;
}): Promise<{ url: string }> {
  const app = new Hono();
  registerLinksGateway(app, {
    registry,
    nats: makeFakeNatsAdapter(),
    validateBearer: opts.validateBearer,
    podId: "pod-test",
    helloTimeoutMs: 500,
    refreshIntervalMs: 60_000,
  });
  server = Bun.serve({
    port: 0,
    fetch: app.fetch.bind(app),
    websocket: { message: () => {}, open: () => {}, close: () => {} },
  });
  return { url: `ws://127.0.0.1:${server.port}/api/links/connect` };
}

describe("ws-gateway auth + handshake", () => {
  test("rejects upgrade without Authorization header", async () => {
    const { url } = await startGateway({ validateBearer: async () => null });
    const ws = new WebSocket(url);
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });
    // Bun maps a non-101 upgrade to close code 1006.
    expect(code).toBe(1006);
  });

  test("rejects invalid bearer", async () => {
    const { url } = await startGateway({ validateBearer: async () => null });
    const ws = new WebSocket(url, {
      // Bun's WebSocket constructor accepts a headers init.
      headers: { authorization: "Bearer wrong" },
    } as unknown as string);
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });
    expect(code).toBe(1006);
  });

  test("accepts valid bearer and waits for hello", async () => {
    const { url } = await startGateway({
      validateBearer: async (t) => (t === "good" ? "user-1" : null),
    });
    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer good" },
    } as unknown as string);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e) => reject(e));
    });
    expect(await registry.get("user-1")).toBeNull(); // not claimed yet
    ws.send(
      encodeFrame({
        type: "hello",
        previewPort: 5174,
        machineId: "m-1",
        hostname: "laptop",
        cliVersion: "1.0.0",
        capabilities: ["decopilot-sandbox"],
      }),
    );
    // Poll until claim shows up.
    for (let i = 0; i < 20; i++) {
      const c = await registry.get("user-1");
      if (c) {
        expect(c.previewPort).toBe(5174);
        expect(c.podId).toBe("pod-test");
        ws.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("claim never appeared");
  });

  test("closes WS if hello times out", async () => {
    const { url } = await startGateway({
      validateBearer: async () => "user-1",
    });
    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer ok" },
    } as unknown as string);
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });
    expect(code).toBe(1008); // policy violation (hello timeout)
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test apps/mesh/src/links/ws-gateway.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the gateway skeleton**

```ts
// apps/mesh/src/links/ws-gateway.ts
/**
 * `GET /api/links/connect` — the daemon's WebSocket entry point.
 *
 * Validates the bearer token, upgrades to WebSocket, awaits the daemon's
 * `hello` frame, claims the user in the NATS JS KV bucket, and then
 * subscribes to `links.dispatch.<userSub>` / `links.cancel.<userSub>` to
 * forward dispatches from any mesh pod over the WS.
 *
 * Ownership invariant: at most one pod owns the daemon for a given userSub.
 * Enforced via a JS KV `watch` — if a pod sees a `podId` other than its own,
 * it closes the WS with 4001 "superseded".
 */
import type { Hono } from "hono";
import type { ServerWebSocket } from "bun";
import { decodeFrame, encodeFrame, type DispatchFrame } from "./dispatch-frames";
import type { LinkClaim, LinkClaimRegistry } from "./link-claim-registry";

export const WS_CLOSE_SUPERSEDED = 4001;
export const WS_CLOSE_POLICY = 1008;
export const WS_CLOSE_INTERNAL = 1011;

export interface GatewayNatsAdapter {
  /** Subscribe to a subject; returns an unsubscribe function. */
  subscribe(
    subject: string,
    onMessage: (data: Uint8Array, reply?: string) => void,
  ): () => void;
  publish(subject: string, data: Uint8Array): void;
  /** Used for cancel-subject delivery (single-shot, no reply). */
  request(
    subject: string,
    data: Uint8Array,
    timeoutMs: number,
  ): Promise<Uint8Array | null>;
}

export interface GatewayDeps {
  registry: LinkClaimRegistry;
  nats: GatewayNatsAdapter;
  /** Validate a bearer token; resolve to a userSub or null. */
  validateBearer: (token: string) => Promise<string | null>;
  /** Unique pod id used in the KV claim. */
  podId: string;
  /** Hello frame deadline. Default 5_000. */
  helloTimeoutMs?: number;
  /** Claim refresh interval. Default 20_000. */
  refreshIntervalMs?: number;
}

interface ConnectionState {
  userSub: string;
  hello: Extract<DispatchFrame, { type: "hello" }>;
  refreshTimer: ReturnType<typeof setInterval>;
  stopWatch: () => void;
  unsubscribeDispatch: () => void;
  unsubscribeCancel: () => void;
}

export function registerLinksGateway(
  app: Hono,
  deps: GatewayDeps,
): void {
  const helloTimeoutMs = deps.helloTimeoutMs ?? 5_000;
  const refreshIntervalMs = deps.refreshIntervalMs ?? 20_000;

  app.get("/api/links/connect", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) return new Response("missing bearer", { status: 401 });
    const token = match[1].trim();
    const userSub = await deps.validateBearer(token);
    if (!userSub) return new Response("invalid bearer", { status: 401 });

    const server = (c.env as { server?: { upgrade?: Function } } | undefined)
      ?.server;
    // In Bun, the upgrade happens via the `c.req.raw` request — Hono exposes
    // the underlying server via `c.env.server`. Per-app wiring (task 7) sets
    // `c.env.server` in the fetch handler.
    if (!server || typeof server.upgrade !== "function") {
      return new Response("ws upgrade not available", { status: 500 });
    }

    const upgraded = server.upgrade(c.req.raw, {
      data: { userSub, deps, helloTimeoutMs, refreshIntervalMs },
    });
    if (!upgraded) {
      return new Response("ws upgrade failed", { status: 400 });
    }
    // Returning undefined tells Hono the response was hijacked.
    return new Response(null, { status: 101 });
  });
}

/**
 * Bun WebSocket handlers — wire these into `Bun.serve({ websocket: ... })` in
 * `app.ts`. Kept here so the gateway logic stays in one file.
 */
export interface WsAttachData {
  userSub: string;
  deps: GatewayDeps;
  helloTimeoutMs: number;
  refreshIntervalMs: number;
  // Set after open():
  state?: ConnectionState;
  helloTimer?: ReturnType<typeof setTimeout>;
}

export const gatewayWsHandlers = {
  open(ws: ServerWebSocket<WsAttachData>) {
    ws.data.helloTimer = setTimeout(() => {
      ws.close(WS_CLOSE_POLICY, "hello timeout");
    }, ws.data.helloTimeoutMs);
  },

  async message(ws: ServerWebSocket<WsAttachData>, raw: string | Uint8Array) {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    let frame: DispatchFrame;
    try {
      frame = decodeFrame(text);
    } catch (err) {
      ws.close(
        WS_CLOSE_POLICY,
        `bad frame: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // First frame must be hello.
    if (!ws.data.state) {
      if (frame.type !== "hello") {
        ws.close(WS_CLOSE_POLICY, "first frame must be hello");
        return;
      }
      clearTimeout(ws.data.helloTimer);
      await onHello(ws, frame);
      return;
    }

    // Subsequent frames go to the dispatch demuxer (task 6c).
    await onAfterHello(ws, frame);
  },

  close(ws: ServerWebSocket<WsAttachData>, _code: number, _reason: string) {
    clearTimeout(ws.data.helloTimer);
    const s = ws.data.state;
    if (!s) return;
    clearInterval(s.refreshTimer);
    try {
      s.stopWatch();
    } catch {}
    try {
      s.unsubscribeDispatch();
    } catch {}
    try {
      s.unsubscribeCancel();
    } catch {}
    // Best-effort delete. If we lost ownership, the new owner already
    // overwrote our claim and this is a no-op or a stale delete that the
    // new owner's KV watcher will treat appropriately (task 6c).
    void ws.data.deps.registry.delete(s.userSub).catch(() => {});
  },
};

async function onHello(
  ws: ServerWebSocket<WsAttachData>,
  hello: Extract<DispatchFrame, { type: "hello" }>,
): Promise<void> {
  const { userSub, deps, refreshIntervalMs } = ws.data;
  const claim: LinkClaim = {
    podId: deps.podId,
    machineId: hello.machineId,
    hostname: hello.hostname,
    cliVersion: hello.cliVersion,
    previewPort: hello.previewPort,
    connectedAt: Date.now(),
  };
  await deps.registry.put(userSub, claim);

  // Start watching to detect eviction by a newer connection on another pod.
  let initial = true;
  const stopWatch = deps.registry.watch(userSub, (current) => {
    if (initial) {
      initial = false;
      return;
    }
    // If we no longer own it, close the WS — the new owner is somewhere else.
    if (!current || current.podId !== deps.podId) {
      try {
        ws.close(WS_CLOSE_SUPERSEDED, "superseded");
      } catch {}
    }
  });

  // Subscribe to NATS subjects (task 6c implements the handler bodies).
  const unsubscribeDispatch = deps.nats.subscribe(
    `links.dispatch.${userSub}`,
    (data, reply) => onDispatchFromNats(ws, data, reply),
  );
  const unsubscribeCancel = deps.nats.subscribe(
    `links.cancel.${userSub}`,
    (data) => onCancelFromNats(ws, data),
  );

  const refreshTimer = setInterval(() => {
    void deps.registry.put(userSub, { ...claim, connectedAt: Date.now() });
  }, refreshIntervalMs);

  ws.data.state = {
    userSub,
    hello,
    refreshTimer,
    stopWatch,
    unsubscribeDispatch,
    unsubscribeCancel,
  };
}

// Stubs filled in by task 6c.
async function onAfterHello(
  _ws: ServerWebSocket<WsAttachData>,
  _frame: DispatchFrame,
): Promise<void> {
  // Implemented in task 6c (dispatch demux).
}
function onDispatchFromNats(
  _ws: ServerWebSocket<WsAttachData>,
  _data: Uint8Array,
  _reply: string | undefined,
): void {
  // Implemented in task 6c.
}
function onCancelFromNats(
  _ws: ServerWebSocket<WsAttachData>,
  _data: Uint8Array,
): void {
  // Implemented in task 6c.
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `bun test apps/mesh/src/links/ws-gateway.test.ts`
Expected: PASS (4 tests). If the auth-rejection tests fail with a different close code due to Bun-version specifics, accept any close code that indicates an abnormal close (e.g., 1002, 1006, or a clean 1008) and update the test assertion to `expect(code).not.toBe(1000)`.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/links/ws-gateway.ts apps/mesh/src/links/ws-gateway.test.ts
git commit -m "feat(links): WS gateway auth + hello handshake"
```

### Task 6b — Eviction via KV watch

Already covered by the `onHello` body in task 6a — it sets up `stopWatch` that closes the WS with 4001 when a foreign `podId` arrives. Verify with a dedicated test.

- [ ] **Step 1: Add the eviction test**

Append to `apps/mesh/src/links/ws-gateway.test.ts`:

```ts
describe("ws-gateway eviction", () => {
  test("closes WS with 4001 when a different pod claims the user", async () => {
    const { url } = await startGateway({
      validateBearer: async () => "user-1",
    });
    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer x" },
    } as unknown as string);
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve()),
    );
    ws.send(
      encodeFrame({
        type: "hello",
        previewPort: 5174,
        machineId: "m-1",
        cliVersion: "1.0.0",
        capabilities: [],
      }),
    );
    // Wait for the initial claim.
    for (let i = 0; i < 40; i++) {
      if (await registry.get("user-1")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // Simulate a different pod taking ownership.
    await registry.put("user-1", {
      podId: "pod-OTHER",
      machineId: "m-2",
      cliVersion: "1.0.0",
      previewPort: 5175,
      connectedAt: Date.now(),
    });
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });
    expect(code).toBe(4001);
  });
});
```

- [ ] **Step 2: Run the test, expect pass**

Run: `bun test apps/mesh/src/links/ws-gateway.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 3: Commit**

```bash
bun run fmt
git add apps/mesh/src/links/ws-gateway.test.ts
git commit -m "test(links): WS gateway eviction via KV watch"
```

### Task 6c — Dispatch + cancel demux

Implement the request/response multiplexing over the WS, driven by NATS messages on `links.dispatch.<userSub>` and `links.cancel.<userSub>`. Each incoming NATS dispatch carries an encoded `RequestFrame` payload + a NATS reply inbox; subsequent `chunk`/`end`/`error` frames from the daemon get published on that inbox.

- [ ] **Step 1: Add the demux test**

Append to `apps/mesh/src/links/ws-gateway.test.ts`:

```ts
import { decodeFrame as decode } from "./dispatch-frames";

describe("ws-gateway dispatch demux", () => {
  test("forwards a request frame onto the WS and streams chunks back", async () => {
    // We need a NATS adapter that lets us inject a fake dispatch and capture replies.
    const replies: Uint8Array[] = [];
    const inbox = "_INBOX.abc";
    const adapter: ReturnType<typeof makeFakeNatsAdapter> = {
      subs: [],
      subscribe(subject: string, cb) {
        this.subs.push(subject);
        if (subject.startsWith("links.dispatch.")) {
          // Defer the dispatch until after the test sends hello.
          setTimeout(() => {
            cb(
              new TextEncoder().encode(
                encodeFrame({
                  type: "request",
                  reqId: "r-1",
                  method: "GET",
                  path: "/_sandbox/runs/abc",
                  headers: {},
                }),
              ),
              inbox,
            );
          }, 50);
        }
        return () => {};
      },
      publish(subject, data) {
        if (subject === inbox) replies.push(data);
      },
      async request() {
        return null;
      },
    };

    const app = new Hono();
    registerLinksGateway(app, {
      registry,
      nats: adapter,
      validateBearer: async () => "user-1",
      podId: "pod-test",
      helloTimeoutMs: 1_000,
      refreshIntervalMs: 60_000,
    });
    server = Bun.serve({
      port: 0,
      fetch: app.fetch.bind(app),
      websocket: { open: () => {}, message: () => {}, close: () => {} },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/links/connect`, {
      headers: { authorization: "Bearer t" },
    } as unknown as string);
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    const incoming: DispatchFrame[] = [];
    ws.addEventListener("message", (e) => {
      incoming.push(decode(typeof e.data === "string" ? e.data : ""));
    });

    ws.send(
      encodeFrame({
        type: "hello",
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      }),
    );

    // Wait until we receive the request frame.
    for (let i = 0; i < 40; i++) {
      if (incoming.find((f) => f.type === "request")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const req = incoming.find((f) => f.type === "request");
    expect(req).toBeDefined();
    expect(req!.type).toBe("request");

    // Simulate the daemon streaming a chunk + end back.
    ws.send(encodeFrame({ type: "chunk", reqId: "r-1", data: "hello" }));
    ws.send(encodeFrame({ type: "end", reqId: "r-1" }));

    // Wait until both replies land.
    for (let i = 0; i < 40; i++) {
      if (replies.length >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(replies.length).toBe(2);
    const decoded = replies.map((b) => decode(new TextDecoder().decode(b)));
    expect(decoded[0].type).toBe("chunk");
    expect(decoded[1].type).toBe("end");
    ws.close();
  });
});
```

- [ ] **Step 2: Implement the demux in `ws-gateway.ts`**

Replace the stubs at the bottom of `apps/mesh/src/links/ws-gateway.ts` with:

```ts
/**
 * Per-WS map of in-flight requests. `reqId` → reply inbox so we know where to
 * publish chunks/end/error back on NATS. We also use it to ignore stray
 * frames for unknown reqIds.
 */
type Inflight = Map<string, { reply: string }>;
function getInflight(ws: ServerWebSocket<WsAttachData>): Inflight {
  const data = ws.data as WsAttachData & { _inflight?: Inflight };
  if (!data._inflight) data._inflight = new Map();
  return data._inflight;
}

function onDispatchFromNats(
  ws: ServerWebSocket<WsAttachData>,
  data: Uint8Array,
  reply: string | undefined,
): void {
  if (!reply) return; // require a reply inbox for streaming
  let frame: DispatchFrame;
  try {
    frame = decodeFrame(new TextDecoder().decode(data));
  } catch {
    return; // malformed dispatch; drop
  }
  if (frame.type !== "request") return;
  getInflight(ws).set(frame.reqId, { reply });
  ws.send(encodeFrame(frame));
}

function onCancelFromNats(
  ws: ServerWebSocket<WsAttachData>,
  data: Uint8Array,
): void {
  let frame: DispatchFrame;
  try {
    frame = decodeFrame(new TextDecoder().decode(data));
  } catch {
    return;
  }
  if (frame.type !== "cancel") return;
  if (!getInflight(ws).has(frame.reqId)) return;
  ws.send(encodeFrame(frame));
}

async function onAfterHello(
  ws: ServerWebSocket<WsAttachData>,
  frame: DispatchFrame,
): Promise<void> {
  // Hello after hello is a protocol error.
  if (frame.type === "hello") {
    ws.close(WS_CLOSE_POLICY, "duplicate hello");
    return;
  }
  // request / cancel from the daemon? Those flow the other direction — drop.
  if (frame.type === "request" || frame.type === "cancel") return;

  const inflight = getInflight(ws);
  const entry = inflight.get(frame.reqId);
  if (!entry) return; // stale or unknown reqId

  const encoder = new TextEncoder();
  ws.data.deps.nats.publish(entry.reply, encoder.encode(encodeFrame(frame)));

  if (frame.type === "end" || frame.type === "error") {
    inflight.delete(frame.reqId);
  }
}
```

- [ ] **Step 3: Run the test, expect pass**

Run: `bun test apps/mesh/src/links/ws-gateway.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
bun run fmt
git add apps/mesh/src/links/ws-gateway.ts apps/mesh/src/links/ws-gateway.test.ts
git commit -m "feat(links): WS gateway dispatch/cancel demux"
```

---

## Task 7: Wire WS gateway into `app.ts` startup

**Files:**
- Modify: `apps/mesh/src/api/app.ts` (the `registerLinksRoutes(app, …)` call at lines 274–279 and the surrounding plumbing)
- Modify: `apps/mesh/src/index.ts` (the file that calls `Bun.serve(...)` — find via `grep -n "Bun.serve" apps/mesh/src/index.ts`; the `websocket` field on the Bun.serve config needs to gain `gatewayWsHandlers`)

The subagent must read `apps/mesh/src/api/app.ts` lines 1–280 to see how routes are wired and what's already in scope (NatsProvider, ContextFactory, etc.) before editing.

The Better Auth bearer validator needs a function that resolves a session by access token. Read `apps/mesh/src/auth/index.ts` (if it exists) or grep for `auth.api.getSession` / `betterAuth(` to find the right API. Bun pattern: pass headers as a `Headers` object to `auth.api.getSession({ headers })`.

- [ ] **Step 1: Construct the gateway deps in `app.ts`**

In `apps/mesh/src/api/app.ts`, replace the current `registerLinksRoutes` call (lines 274–279) with:

```ts
import {
  NatsLinkClaimRegistry,
  type LinkClaimRegistry,
} from "../links/link-claim-registry";
import {
  gatewayWsHandlers,
  registerLinksGateway,
  type GatewayNatsAdapter,
  type WsAttachData,
} from "../links/ws-gateway";

// ... within the function that builds the app, after natsProvider is set up:

const claimRegistry = new NatsLinkClaimRegistry({
  getJetStream: () => natsProvider.getJetStream(),
});
natsProvider.onReady(() => {
  void claimRegistry.init();
});

const podId = process.env.POD_ID ?? `pod-${crypto.randomUUID()}`;

const natsAdapter: GatewayNatsAdapter = {
  subscribe(subject, onMessage) {
    const nc = natsProvider.getConnection();
    if (!nc) return () => {};
    const sub = nc.subscribe(subject);
    void (async () => {
      for await (const m of sub) {
        try {
          onMessage(m.data, m.reply);
        } catch {
          // swallow
        }
      }
    })();
    return () => {
      try {
        sub.unsubscribe();
      } catch {
        /* */
      }
    };
  },
  publish(subject, data) {
    const nc = natsProvider.getConnection();
    nc?.publish(subject, data);
  },
  async request(subject, data, timeoutMs) {
    const nc = natsProvider.getConnection();
    if (!nc) return null;
    try {
      const reply = await nc.request(subject, data, { timeout: timeoutMs });
      return reply.data;
    } catch {
      return null;
    }
  },
};

registerLinksGateway(app, {
  registry: claimRegistry,
  nats: natsAdapter,
  podId,
  validateBearer: async (token) => {
    // Better Auth resolves a session from cookies OR an Authorization header.
    const headers = new Headers({ authorization: `Bearer ${token}` });
    const session = await auth.api.getSession({ headers });
    return session?.user?.id ?? null;
  },
});

// Export so the Bun.serve setup can register the WS handlers.
export { gatewayWsHandlers };
export type { WsAttachData };
```

(The `auth` variable should already be in scope — it's the Better Auth instance the existing `registerLinksRoutes` was using. Confirm via grep: `grep -n "auth.api" apps/mesh/src/api/app.ts`.)

- [ ] **Step 2: Wire the websocket handlers into `Bun.serve`**

Find the `Bun.serve` call (likely in `apps/mesh/src/index.ts` or wherever the server boots). Add:

```ts
import { gatewayWsHandlers, type WsAttachData } from "./api/app";

const server = Bun.serve<WsAttachData>({
  // ...existing config...
  websocket: gatewayWsHandlers,
  fetch: (req, srv) => {
    // The route handler needs `srv.upgrade(...)` access via `c.env.server`.
    return app.fetch(req, { server: srv } as unknown as Env["Bindings"]);
  },
});
```

(If there's already a `websocket` field for other purposes, merge — but the codebase survey found no existing Bun.serve websocket usage in the mesh entry point, so a clean add is expected.)

- [ ] **Step 3: Typecheck**

Run: `bun run check`
Expected: no new errors. If `auth.api.getSession` has a different shape, adjust the `validateBearer` call. The exact API signature can be confirmed by grepping for existing call sites: `grep -rn "auth.api.getSession" apps/mesh/src/`.

- [ ] **Step 4: Commit**

```bash
bun run fmt
git add apps/mesh/src/api/app.ts apps/mesh/src/index.ts
git commit -m "feat(links): wire WS gateway into mesh app startup"
```

---

## Task 8: Cluster-side dispatcher (`dispatchToDaemon`)

**Files:**
- Create: `apps/mesh/src/links/dispatcher.ts`
- Test: `apps/mesh/src/links/dispatcher.test.ts`

The dispatcher is the cluster-side counterpart to the WS gateway's NATS subscription. Callers do:

```ts
for await (const chunk of dispatchToDaemon(userSub, { method, path, headers, body })) {
  // ...
}
```

Internally: open a NATS subscription on a per-call inbox, publish the request frame to `links.dispatch.<userSub>` with `reply: inbox`, iterate the inbox until an `end` or `error` arrives.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/links/dispatcher.test.ts
import { describe, expect, test } from "bun:test";
import { createDispatcher } from "./dispatcher";
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "./dispatch-frames";

function makeFakeNats() {
  const subs = new Map<string, (data: Uint8Array, reply?: string) => void>();
  return {
    publish(subject: string, data: Uint8Array, opts?: { reply?: string }) {
      // Simulate the gateway: the test will register a handler for
      // links.dispatch.<userSub> that responds with chunks on `opts.reply`.
      const handler = subs.get(subject);
      handler?.(data, opts?.reply);
    },
    subscribe(
      subject: string,
      cb: (data: Uint8Array, reply?: string) => void,
    ): () => void {
      subs.set(subject, cb);
      return () => subs.delete(subject);
    },
    createInbox(): string {
      return `_INBOX.${Math.random().toString(36).slice(2)}`;
    },
  };
}

describe("dispatcher", () => {
  test("yields chunks until end frame, then completes", async () => {
    const nats = makeFakeNats();

    // Pretend to be the WS gateway: when a dispatch lands, stream two chunks
    // then an end frame on the reply inbox.
    nats.subscribe("links.dispatch.user-1", (data, reply) => {
      const req = decodeFrame(new TextDecoder().decode(data));
      expect(req.type).toBe("request");
      const enc = new TextEncoder();
      const chunk1 = encodeFrame({
        type: "chunk",
        reqId: (req as any).reqId,
        data: "a",
      } as DispatchFrame);
      const chunk2 = encodeFrame({
        type: "chunk",
        reqId: (req as any).reqId,
        data: "b",
      } as DispatchFrame);
      const end = encodeFrame({
        type: "end",
        reqId: (req as any).reqId,
      } as DispatchFrame);
      // Replies arrive as messages on the inbox subscription.
      setTimeout(() => {
        const inbox = nats as unknown as ReturnType<typeof makeFakeNats>;
        const handler = (inbox as any).subs.get(reply!);
        handler?.(enc.encode(chunk1));
        handler?.(enc.encode(chunk2));
        handler?.(enc.encode(end));
      }, 0);
    });

    const dispatch = createDispatcher({ nats, requestTimeoutMs: 5_000 });
    const out: string[] = [];
    for await (const chunk of dispatch("user-1", {
      method: "GET",
      path: "/_sandbox/x",
      headers: {},
    })) {
      out.push(chunk.data);
    }
    expect(out).toEqual(["a", "b"]);
  });

  test("throws when an error frame arrives", async () => {
    const nats = makeFakeNats();
    nats.subscribe("links.dispatch.user-1", (data, reply) => {
      const req = decodeFrame(new TextDecoder().decode(data));
      const enc = new TextEncoder();
      const errFrame = encodeFrame({
        type: "error",
        reqId: (req as any).reqId,
        code: "BOOM",
        message: "kaboom",
      } as DispatchFrame);
      setTimeout(() => {
        const handler = (nats as any).subs.get(reply!);
        handler?.(enc.encode(errFrame));
      }, 0);
    });
    const dispatch = createDispatcher({ nats, requestTimeoutMs: 5_000 });
    await expect(async () => {
      for await (const _ of dispatch("user-1", {
        method: "GET",
        path: "/x",
        headers: {},
      }));
    }).toThrow(/kaboom/);
  });

  test("times out if no reply arrives", async () => {
    const nats = makeFakeNats();
    // No subscriber for links.dispatch.user-1.
    const dispatch = createDispatcher({ nats, requestTimeoutMs: 100 });
    await expect(async () => {
      for await (const _ of dispatch("user-1", {
        method: "GET",
        path: "/x",
        headers: {},
      }));
    }).toThrow(/timeout/i);
  });

  test("publishes cancel on caller abort", async () => {
    const nats = makeFakeNats();
    const cancels: Array<{ subject: string; data: Uint8Array }> = [];
    const origPublish = nats.publish.bind(nats);
    (nats as any).publish = (
      subject: string,
      data: Uint8Array,
      opts?: { reply?: string },
    ) => {
      if (subject === "links.cancel.user-1") cancels.push({ subject, data });
      origPublish(subject, data, opts);
    };
    // Subscribe but never reply so the iterator hangs until aborted.
    nats.subscribe("links.dispatch.user-1", () => {});
    const dispatch = createDispatcher({ nats, requestTimeoutMs: 5_000 });
    const ac = new AbortController();
    const iter = dispatch(
      "user-1",
      { method: "GET", path: "/x", headers: {} },
      { signal: ac.signal },
    );
    const next = (async () => {
      for await (const _ of iter);
    })();
    setTimeout(() => ac.abort(), 50);
    await expect(next).rejects.toThrow();
    expect(cancels.length).toBeGreaterThanOrEqual(1);
    const decoded = decodeFrame(new TextDecoder().decode(cancels[0].data));
    expect(decoded.type).toBe("cancel");
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test apps/mesh/src/links/dispatcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dispatcher**

```ts
// apps/mesh/src/links/dispatcher.ts
/**
 * dispatchToDaemon: cluster → daemon over NATS.
 *
 * Encodes a `request` frame, publishes it on `links.dispatch.<userSub>` with
 * a per-call reply inbox, and yields `ChunkFrame.data` strings as they arrive
 * on the inbox. Terminates on `end` (clean) or `error` (throws). On caller
 * abort, publishes a `cancel` on `links.cancel.<userSub>` so the owner pod
 * can forward it to the daemon.
 */
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "./dispatch-frames";

export interface DispatcherNatsAdapter {
  publish(subject: string, data: Uint8Array, opts?: { reply?: string }): void;
  subscribe(
    subject: string,
    onMessage: (data: Uint8Array, reply?: string) => void,
  ): () => void;
  createInbox(): string;
}

export interface DispatchRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface DispatchChunk {
  data: string;
}

export interface DispatchOptions {
  signal?: AbortSignal;
}

export interface CreateDispatcherDeps {
  nats: DispatcherNatsAdapter;
  /** First-chunk timeout. Default 30_000. */
  requestTimeoutMs?: number;
}

export type DispatchFn = (
  userSub: string,
  req: DispatchRequest,
  opts?: DispatchOptions,
) => AsyncIterable<DispatchChunk>;

export function createDispatcher(deps: CreateDispatcherDeps): DispatchFn {
  const timeoutMs = deps.requestTimeoutMs ?? 30_000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return function dispatch(userSub, req, opts) {
    return {
      async *[Symbol.asyncIterator]() {
        const reqId = crypto.randomUUID();
        const inbox = deps.nats.createInbox();
        const queue: DispatchFrame[] = [];
        let resolve: (() => void) | null = null;
        let done = false;
        let error: Error | null = null;

        const wake = (): void => {
          const r = resolve;
          resolve = null;
          r?.();
        };

        const unsubscribe = deps.nats.subscribe(inbox, (data) => {
          if (done) return;
          try {
            queue.push(decodeFrame(decoder.decode(data)));
          } catch (err) {
            error = err instanceof Error ? err : new Error(String(err));
            done = true;
          }
          wake();
        });

        const cleanup = (): void => {
          done = true;
          try {
            unsubscribe();
          } catch {
            /* */
          }
        };

        const onAbort = (): void => {
          deps.nats.publish(
            `links.cancel.${userSub}`,
            encoder.encode(encodeFrame({ type: "cancel", reqId })),
          );
          error = new Error("dispatch aborted");
          cleanup();
          wake();
        };
        opts?.signal?.addEventListener("abort", onAbort, { once: true });

        deps.nats.publish(
          `links.dispatch.${userSub}`,
          encoder.encode(
            encodeFrame({
              type: "request",
              reqId,
              method: req.method,
              path: req.path,
              headers: req.headers,
              ...(req.body !== undefined ? { body: req.body } : {}),
            }),
          ),
          { reply: inbox },
        );

        const firstReplyDeadline = Date.now() + timeoutMs;
        let receivedAny = false;

        try {
          while (!done) {
            if (queue.length === 0) {
              const remaining = firstReplyDeadline - Date.now();
              if (!receivedAny && remaining <= 0) {
                throw new Error("dispatch timeout: no reply from daemon");
              }
              await new Promise<void>((res) => {
                resolve = res;
                if (!receivedAny) {
                  setTimeout(wake, Math.max(0, remaining));
                }
              });
              if (error) throw error;
              continue;
            }
            const frame = queue.shift()!;
            receivedAny = true;
            if (frame.type === "chunk") {
              yield { data: frame.data };
            } else if (frame.type === "end") {
              return;
            } else if (frame.type === "error") {
              throw new Error(`${frame.code}: ${frame.message}`);
            } else {
              // headers or other frame types — ignore for v1
            }
          }
          if (error) throw error;
        } finally {
          opts?.signal?.removeEventListener("abort", onAbort);
          cleanup();
        }
      },
    };
  };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `bun test apps/mesh/src/links/dispatcher.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/links/dispatcher.ts apps/mesh/src/links/dispatcher.test.ts
git commit -m "feat(links): cluster-side dispatchToDaemon over NATS"
```

---

## Task 9: Rewrite `remoteDispatch` to use `dispatchToDaemon`

**Files:**
- Modify: `apps/mesh/src/harnesses/remote-dispatch.ts`
- Delete: `apps/mesh/src/harnesses/remote-dispatch.test.ts` (the existing test is for the HTTP+HMAC path)
- Create: `apps/mesh/src/harnesses/remote-dispatch.test.ts` (new shape)

`remoteDispatch` today takes `link: RemoteDispatchLink` and a `sandboxApiUrl: string`, builds HTTP requests, signs them with HMAC, parses SSE. New shape: takes `userSub: string` and a `DispatchFn`, returns `AsyncIterable<UIMessageChunk>` as before. The wire SSE → `ui-message-chunk` parsing collapses because the daemon now emits `chunk` frames whose `data` is the JSON of the `dispatchSSEEventSchema` payload (preserve that envelope for back-compat with `dispatchSSEEventSchema`).

- [ ] **Step 1: Delete the old test**

```bash
rm apps/mesh/src/harnesses/remote-dispatch.test.ts
```

- [ ] **Step 2: Write the new test**

```ts
// apps/mesh/src/harnesses/remote-dispatch.test.ts
import { describe, expect, test } from "bun:test";
import { remoteDispatch } from "./remote-dispatch";
import type { DispatchChunk, DispatchFn } from "../links/dispatcher";

function makeStubDispatch(events: Array<Record<string, unknown>>): DispatchFn {
  return function dispatch(_userSub, req) {
    return {
      async *[Symbol.asyncIterator]() {
        // Confirm the path carries the handle as `/_sandbox/<handle>/dispatch`.
        expect(req.path).toMatch(/^\/_sandbox\/[^/]+\/dispatch$/);
        // The daemon reverse-proxies the sandbox's SSE response, so we ship
        // raw SSE bytes (one `data:` line per event, terminated by \n\n).
        for (const ev of events) {
          yield {
            data: `data: ${JSON.stringify(ev)}\n\n`,
          } as DispatchChunk;
        }
      },
    };
  };
}

describe("remoteDispatch (NATS-backed)", () => {
  test("yields ui-message-chunks", async () => {
    const dispatch = makeStubDispatch([
      { type: "ui-message-chunk", chunk: { id: "1" } },
      { type: "ui-message-chunk", chunk: { id: "2" } },
      { type: "done" },
    ]);
    const chunks: any[] = [];
    for await (const c of remoteDispatch(
      "harness-1",
      {
        runId: "run-1",
        agentMessages: [],
      } as any,
      "user-1",
      "abc",
      { dispatch },
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ id: "1" }, { id: "2" }]);
  });

  test("throws on error event", async () => {
    const dispatch = makeStubDispatch([
      { type: "error", code: "X", message: "boom" },
    ]);
    await expect(async () => {
      for await (const _ of remoteDispatch(
        "h",
        { runId: "r" } as any,
        "u",
        "abc",
        { dispatch },
      ));
    }).toThrow(/boom/);
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `bun test apps/mesh/src/harnesses/remote-dispatch.test.ts`
Expected: FAIL — the function signature still requires `link` and `sandboxApiUrl`.

- [ ] **Step 4: Rewrite the implementation**

Replace the full contents of `apps/mesh/src/harnesses/remote-dispatch.ts` with:

```ts
/**
 * Remote dispatch — cluster → daemon over the WS+NATS link path.
 *
 * The daemon's control handler reverse-proxies `/_sandbox/<handle>/dispatch`
 * to the spawned sandbox daemon, which emits an SSE response. The bytes
 * arrive at us as raw chunk-frame payloads; we reassemble SSE events and
 * decode each event's JSON via `dispatchSSEEventSchema`.
 */
import type { UIMessageChunk } from "ai";
import { dispatchSSEEventSchema } from "../links/protocol";
import type { DispatchFn } from "../links/dispatcher";
import type { HarnessId, HarnessStreamInput } from "./types";

export interface RemoteDispatchDeps {
  dispatch: DispatchFn;
}

export function remoteDispatch(
  id: HarnessId,
  input: HarnessStreamInput,
  userSub: string,
  sandboxHandle: string,
  deps: RemoteDispatchDeps,
): AsyncIterable<UIMessageChunk> {
  const { signal, processLocal: _processLocal, ...wireInput } = input;
  return {
    async *[Symbol.asyncIterator]() {
      const body = JSON.stringify({ harnessId: id, input: wireInput });
      const iter = deps.dispatch(
        userSub,
        {
          method: "POST",
          path: `/_sandbox/${sandboxHandle}/dispatch`,
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body,
        },
        { signal },
      );

      let buffer = "";
      const emitEvent = function* (
        eventText: string,
      ): Generator<UIMessageChunk> {
        // One SSE event block. Pull `data: ...` lines, join with \n, parse JSON.
        const dataLines = eventText
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice("data: ".length));
        if (dataLines.length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(dataLines.join("\n"));
        } catch {
          return;
        }
        const ev = dispatchSSEEventSchema.safeParse(parsed);
        if (!ev.success) return;
        if (ev.data.type === "ui-message-chunk") {
          yield ev.data.chunk as UIMessageChunk;
        } else if (ev.data.type === "error") {
          throw new Error(
            `[remoteDispatch] ${ev.data.code}: ${ev.data.message}`,
          );
        }
        // `done` returns no chunk — the outer loop ends when the iterable closes.
      };

      for await (const raw of iter) {
        buffer += raw.data;
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const eventBlock = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const chunk of emitEvent(eventBlock)) yield chunk;
          sep = buffer.indexOf("\n\n");
        }
      }
      // Flush any trailing event missing the terminating \n\n.
      const tail = buffer.trim();
      if (tail.length > 0) {
        for (const chunk of emitEvent(tail)) yield chunk;
      }
    },
  };
}
```

- [ ] **Step 5: Run the test, expect pass**

Run: `bun test apps/mesh/src/harnesses/remote-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/harnesses/remote-dispatch.ts apps/mesh/src/harnesses/remote-dispatch.test.ts
git commit -m "feat(links): rewrite remoteDispatch to use dispatchToDaemon"
```

---

## Task 10: Rewire `remoteDispatch` call sites

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` (call site for `remoteDispatch`)
- Modify: `apps/mesh/src/sandbox/lifecycle.ts:202` and any other site that today passes `link.tunnelUrl` / `link.linkSecret`
- Modify: `apps/mesh/src/tools/sandbox/start.ts` around line 383

The subagent must grep for callers to be comprehensive: `grep -rn "remoteDispatch(" apps/mesh/src/` and `grep -rn "tunnelUrl" apps/mesh/src/`.

For each site:
- Drop the `link.tunnelUrl` / `link.linkSecret` arguments and `sandboxApiUrl`.
- Pass `userSub` (read from the link entry's `userId` field or from `MeshContext.auth.user.id` depending on the call site).
- Pass the `sandboxHandle` — the per-sandbox handle (today derived from `computeHandle(sandboxId, branch)`). Each call site already has this in scope (it's the handle the cluster sends in `POST /api/sandboxes` to ensure the sandbox); thread it through.
- Pass the shared `dispatch` (the cluster-side dispatcher from task 8). Wire it up in the request context: add a `dispatch` field to `MeshContext` (look at `apps/mesh/src/core/context-factory.ts`) and populate it from the shared `createDispatcher({ nats: dispatcherNatsAdapter })`.

- [ ] **Step 1: Add `dispatch: DispatchFn` to `MeshContext`**

Modify `apps/mesh/src/core/context-factory.ts` to add `dispatch?: DispatchFn` to `MeshContextConfig` and to the `MeshContext` shape. Populate it from a singleton `createDispatcher({ nats: dispatcherAdapter })` constructed near the NATS bootstrap in `apps/mesh/src/api/app.ts`.

The dispatcher's `nats` adapter shape is in task 8; create one with the same `nats` package as the gateway:

```ts
// in app.ts (near the gateway nats adapter setup from task 7):
import { createDispatcher } from "../links/dispatcher";

const dispatcherNatsAdapter = {
  publish(subject: string, data: Uint8Array, opts?: { reply?: string }) {
    natsProvider
      .getConnection()
      ?.publish(subject, data, opts?.reply ? { reply: opts.reply } : undefined);
  },
  subscribe(subject: string, cb: (data: Uint8Array, reply?: string) => void) {
    const nc = natsProvider.getConnection();
    if (!nc) return () => {};
    const sub = nc.subscribe(subject);
    void (async () => {
      for await (const m of sub) cb(m.data, m.reply);
    })();
    return () => {
      try {
        sub.unsubscribe();
      } catch {}
    };
  },
  createInbox() {
    const nc = natsProvider.getConnection();
    return (
      nc?.createInbox?.() ??
      `_INBOX.${crypto.randomUUID().replace(/-/g, "")}`
    );
  },
};
const dispatch = createDispatcher({ nats: dispatcherNatsAdapter });
```

Then pass `dispatch` into the context factory or expose it via a module-level export (`export const getDispatch = () => dispatch`).

- [ ] **Step 2: Update `apps/mesh/src/api/routes/decopilot/dispatch-run.ts`**

Subagent reads the file, identifies the `remoteDispatch(...)` call. The call previously looked roughly like:

```ts
const stream = remoteDispatch(
  harnessId,
  input,
  { tunnelUrl: link.tunnelUrl, linkSecret: link.linkSecret },
  sandboxApiUrl,
);
```

Replace with:

```ts
const stream = remoteDispatch(harnessId, input, link.userId, { dispatch });
```

Where `dispatch` is the shared dispatcher from step 1 (imported via `getDispatch()` or from the context). `link.userId` is the existing field on `LinkEntry`.

- [ ] **Step 3: Update `apps/mesh/src/sandbox/lifecycle.ts:202`**

The original (line 202) is:

```ts
return new DesktopSandboxProvider({
  link: { tunnelUrl: link.tunnelUrl, linkSecret: link.linkSecret },
  stateStore,
});
```

Replace with:

```ts
return new DesktopSandboxProvider({
  userSub: link.userId,
  dispatch: getDispatch(),
  stateStore,
});
```

The `@decocms/sandbox/provider/desktop` DesktopSandboxProvider class itself lives in `packages/sandbox/server/provider/desktop/`. Subagent must update that file too — replace its `link` config with `userSub`+`dispatch`, and replace its `fetch(...)`+HMAC-sign calls with `for await (const c of dispatch(userSub, req))`. Use task 9's `remoteDispatch` as a template.

- [ ] **Step 4: Update `apps/mesh/src/tools/sandbox/start.ts` around line 383**

The line currently reads:

```ts
sandboxApiUrl: sandbox.previewUrl, // for desktop the two are equal
```

This field flows downstream into provider construction. If the downstream consumer is the `DesktopSandboxProvider` above (which now takes `userSub`), drop the field entirely; otherwise pass `userSub` instead. Subagent traces the dataflow to determine the right change.

- [ ] **Step 5: Typecheck and run the existing test suite**

```bash
bun run check
bun test apps/mesh/src/
```

Expected: zero new type errors. Old tests for `tunnelUrl` / HMAC paths may fail or no longer compile — that's expected; they'll be deleted in task 16.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add -A apps/mesh/src/ packages/sandbox/
git commit -m "refactor(links): route remoteDispatch and DesktopSandboxProvider through dispatchToDaemon"
```

---

## Task 11: Daemon-side in-process control handler

**Files:**
- Create: `apps/mesh/src/link-daemon/control-handler.ts`
- Test: `apps/mesh/src/link-daemon/control-handler.test.ts`

This is the in-process replacement for the `control-plane.ts` HTTP handler. It handles two kinds of frames:

1. **Lifecycle (in-process):** `POST /api/sandboxes`, `DELETE /api/sandboxes/<handle>` — call into the `DesktopSandboxProvider` directly.
2. **Reverse-proxy to a spawned sandbox daemon (streaming):** `POST /_sandbox/<handle>/dispatch`, `DELETE /_sandbox/<handle>/runs/<runId>`, and any other `/_sandbox/<handle>/...` path — fetch from `http://127.0.0.1:<sandboxPort>/_sandbox/...` (path with the handle stripped) and pipe the response. This replaces the previous architecture where each sandbox had its own warp tunnel.

The existing `control-plane.ts` (lines 67–100) shows the lifecycle routes; the new handler does the same routing minus the HMAC verification, minus the HTTP wrapping, **plus** the reverse-proxy for `/_sandbox/<handle>/*` paths.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/link-daemon/control-handler.test.ts
import { describe, expect, test } from "bun:test";
import { createControlHandler } from "./control-handler";
import type { DesktopSandboxProvider } from "./user-desktop-provider";

function fakeProvider(): DesktopSandboxProvider {
  return {
    async ensureSandbox(input) {
      return {
        sandboxApiUrl: `http://127.0.0.1:9000`,
        port: 9000,
      };
    },
    proxyPort() {
      return 9000;
    },
    recordHit() {},
    acquireDispatch() {
      return () => {};
    },
    listSandboxes() {
      return [];
    },
    async deleteSandbox() {},
    async shutdown() {},
  };
}

describe("control-handler", () => {
  test("POST /api/sandboxes ensures and returns sandboxApiUrl", async () => {
    const handler = createControlHandler({ provider: fakeProvider() });
    const res = await handler.handle({
      type: "request",
      reqId: "r",
      method: "POST",
      path: "/api/sandboxes",
      headers: {},
      body: JSON.stringify({ handle: "abc" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({
      sandboxApiUrl: "http://127.0.0.1:9000",
    });
  });

  test("DELETE /api/sandboxes/<handle> tears down", async () => {
    let deletedHandle: string | null = null;
    const provider = fakeProvider();
    provider.deleteSandbox = async (h: string) => {
      deletedHandle = h;
    };
    const handler = createControlHandler({ provider });
    const res = await handler.handle({
      type: "request",
      reqId: "r",
      method: "DELETE",
      path: "/api/sandboxes/abc",
      headers: {},
    });
    expect(res.status).toBe(204);
    expect(deletedHandle).toBe("abc");
  });

  test("unknown path → 404", async () => {
    const handler = createControlHandler({ provider: fakeProvider() });
    const res = await handler.handle({
      type: "request",
      reqId: "r",
      method: "GET",
      path: "/nope",
      headers: {},
    });
    expect(res.status).toBe(404);
  });

  test("missing handle in POST → 400", async () => {
    const handler = createControlHandler({ provider: fakeProvider() });
    const res = await handler.handle({
      type: "request",
      reqId: "r",
      method: "POST",
      path: "/api/sandboxes",
      headers: {},
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test apps/mesh/src/link-daemon/control-handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/mesh/src/link-daemon/control-handler.ts
/**
 * In-process control handler for the daemon. Replaces the previous HTTP+HMAC
 * `control-plane.ts`. The cluster-connection demuxer (task 12) calls
 * `handle(requestFrame)` for one-shot routes, and `handleStream(requestFrame)`
 * for `/_sandbox/<handle>/*` paths whose responses stream.
 *
 * Routes:
 *   POST   /api/sandboxes                 → ensureSandbox (in-process)
 *   DELETE /api/sandboxes/<handle>        → deleteSandbox (in-process)
 *   *      /_sandbox/<handle>/<rest>      → reverse-proxy to the spawned
 *                                            sandbox daemon's local port
 */
import type { RequestFrame } from "../links/dispatch-frames";
import type { DesktopSandboxProvider, RepoRef } from "./user-desktop-provider";

export interface ControlHandlerResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface ControlHandlerDeps {
  provider: DesktopSandboxProvider;
  /** Default `fetch`; tests inject. */
  fetchImpl?: typeof fetch;
}

interface EnsureSandboxBody {
  handle: string;
  repo?: RepoRef;
}

export interface ControlHandler {
  /** Single-response routes (sandbox lifecycle + non-streaming proxies). */
  handle(req: RequestFrame): Promise<ControlHandlerResponse>;
  /**
   * Streaming routes (`/_sandbox/<handle>/<...>`). Yields `{type, payload}`
   * objects, JSON-encoded by the cluster-connection into chunk frames.
   */
  handleStream(
    req: RequestFrame,
  ): AsyncIterable<{ type: "raw-chunk"; data: string }>;
}

const SANDBOX_PATH = /^\/_sandbox\/([^/]+)(\/.*)?$/;

export function createControlHandler(deps: ControlHandlerDeps): ControlHandler {
  const fetcher = deps.fetchImpl ?? fetch;

  return {
    async handle(req) {
      if (req.path === "/api/sandboxes" && req.method === "POST") {
        let body: EnsureSandboxBody;
        try {
          body = JSON.parse(req.body ?? "") as EnsureSandboxBody;
        } catch {
          return {
            status: 400,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "invalid_json" }),
          };
        }
        if (typeof body.handle !== "string" || body.handle.length === 0) {
          return {
            status: 400,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "missing_handle" }),
          };
        }
        const { sandboxApiUrl } = await deps.provider.ensureSandbox(body);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sandboxApiUrl }),
        };
      }
      if (req.path.startsWith("/api/sandboxes/") && req.method === "DELETE") {
        const handle = req.path.slice("/api/sandboxes/".length);
        if (!handle) {
          return {
            status: 400,
            body: JSON.stringify({ error: "missing_handle" }),
            headers: { "content-type": "application/json" },
          };
        }
        await deps.provider.deleteSandbox(handle);
        return { status: 204 };
      }

      // Non-streaming reverse-proxy: `/_sandbox/<handle>/runs/<runId>` DELETE
      // and similar. Streaming paths use handleStream instead.
      const sm = SANDBOX_PATH.exec(req.path);
      if (sm) {
        const handle = sm[1];
        const rest = sm[2] ?? "/";
        const port = deps.provider.proxyPort(handle);
        if (port == null) return { status: 404, body: "unknown handle" };
        const res = await fetcher(`http://127.0.0.1:${port}/_sandbox${rest}`, {
          method: req.method,
          headers: req.headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
          redirect: "manual",
        });
        const text = await res.text();
        return {
          status: res.status,
          headers: Object.fromEntries(res.headers),
          body: text,
        };
      }
      return { status: 404, body: "not found" };
    },

    handleStream(req) {
      const sm = SANDBOX_PATH.exec(req.path);
      if (!sm) {
        return (async function* () {})();
      }
      const handle = sm[1];
      const rest = sm[2] ?? "/";
      const port = deps.provider.proxyPort(handle);
      if (port == null) return (async function* () {})();
      const release = deps.provider.acquireDispatch(handle);
      return (async function* () {
        try {
          const res = await fetcher(`http://127.0.0.1:${port}/_sandbox${rest}`, {
            method: req.method,
            headers: req.headers,
            ...(req.body !== undefined ? { body: req.body } : {}),
          });
          if (!res.body) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value && value.length) {
                yield { type: "raw-chunk", data: decoder.decode(value) };
              }
            }
          } finally {
            reader.releaseLock();
          }
        } finally {
          release();
        }
      })();
    },
  };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `bun test apps/mesh/src/link-daemon/control-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/control-handler.ts apps/mesh/src/link-daemon/control-handler.test.ts
git commit -m "feat(link-daemon): in-process control handler (replaces HMAC HTTP)"
```

---

## Task 12: Daemon cluster-connection (WS to mesh)

**Files:**
- Create: `apps/mesh/src/link-daemon/cluster-connection.ts`
- Test: `apps/mesh/src/link-daemon/cluster-connection.test.ts`

The cluster connection:
1. Opens a WS to `<MESH_CLUSTER_URL>/api/links/connect` with `Authorization: Bearer <accessToken>`.
2. Sends the `hello` frame on open.
3. Demuxes incoming `request` and `cancel` frames into the in-process `ControlHandler`.
4. Streams responses (`headers`, `chunk`, `end`, `error`) back over the WS.
5. On disconnect, reconnects per `reconnect-backoff.ts`. WS close code `WS_CLOSE_SUPERSEDED` stops permanently.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/link-daemon/cluster-connection.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "../links/dispatch-frames";
import { connectToCluster, type ClusterConnectionHandle } from "./cluster-connection";

let server: ReturnType<typeof Bun.serve> | null = null;
let handle: ClusterConnectionHandle | null = null;
afterEach(async () => {
  await handle?.close();
  server?.stop(true);
  handle = null;
  server = null;
});

describe("cluster-connection", () => {
  test("sends hello on open and dispatches request frames to handler", async () => {
    const seen: DispatchFrame[] = [];
    let resolveSeen: (() => void) | null = null;
    const seenP = new Promise<void>((r) => {
      resolveSeen = r;
    });

    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req);
          return undefined;
        }
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open(ws) {
          // Wait for hello, then send a request frame.
          ws.send(
            encodeFrame({
              type: "request",
              reqId: "r-1",
              method: "POST",
              path: "/api/sandboxes",
              headers: {},
              body: JSON.stringify({ handle: "abc" }),
            }),
          );
        },
        message(_ws, raw) {
          const text =
            typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          const frame = decodeFrame(text);
          seen.push(frame);
          // Wait for hello + the chunk+end emitted by our handler.
          if (seen.find((s) => s.type === "end")) resolveSeen?.();
        },
        close() {},
      },
    });

    handle = await connectToCluster({
      url: `ws://127.0.0.1:${server.port}/api/links/connect`,
      accessToken: "tok",
      hello: {
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      },
      controlHandler: {
        async handle(req) {
          expect(req.path).toBe("/api/sandboxes");
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"sandboxApiUrl":"http://127.0.0.1:9000"}',
          };
        },
        handleStream() {
          return (async function* () {})();
        },
      },
    });

    await seenP;
    const types = seen.map((s) => s.type);
    expect(types).toContain("hello");
    expect(types).toContain("headers");
    expect(types).toContain("chunk");
    expect(types).toContain("end");
  });

  test("does not reconnect on close code 4001", async () => {
    let opens = 0;
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req);
          return undefined;
        }
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open(ws) {
          opens++;
          ws.close(4001, "superseded");
        },
        message() {},
        close() {},
      },
    });
    handle = await connectToCluster({
      url: `ws://127.0.0.1:${server.port}/api/links/connect`,
      accessToken: "t",
      hello: {
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      },
      controlHandler: {
        async handle() {
          return { status: 404 };
        },
        handleStream() {
          return (async function* () {})();
        },
      },
      maxAttempts: 5,
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(opens).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test apps/mesh/src/link-daemon/cluster-connection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/mesh/src/link-daemon/cluster-connection.ts
/**
 * The daemon's persistent WebSocket connection to the cluster.
 *
 * - Opens `ws(s)://<cluster>/api/links/connect` with bearer auth.
 * - Sends `hello` once open.
 * - Demultiplexes `request` / `cancel` frames into the in-process control
 *   handler (task 11). For non-streaming endpoints the response is a single
 *   `headers` + `chunk` + `end`; for the streaming dispatch endpoint we stream
 *   each `{type, payload}` event as a JSON-encoded chunk frame.
 * - Reconnects per `reconnect-backoff.ts`. Stops on `WS_CLOSE_SUPERSEDED`.
 */
import { computeBackoffMs, shouldReconnectOnClose } from "./reconnect-backoff";
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "../links/dispatch-frames";
import type { ControlHandler } from "./control-handler";

export interface ClusterConnectionInput {
  url: string;
  accessToken: string;
  hello: {
    previewPort: number;
    machineId: string;
    hostname?: string;
    cliVersion: string;
    capabilities: string[];
  };
  controlHandler: ControlHandler;
  /** Cap on reconnect attempts. Default `Infinity` (retry forever). */
  maxAttempts?: number;
  /** Resolved when the daemon connects successfully at least once. */
  onConnected?: () => void;
}

export interface ClusterConnectionHandle {
  /** Trigger an orderly shutdown (no reconnect). */
  close(): Promise<void>;
  /** Resolves when the connection is permanently closed (e.g., 4001 or `close()`). */
  closed: Promise<void>;
}

export async function connectToCluster(
  input: ClusterConnectionInput,
): Promise<ClusterConnectionHandle> {
  const maxAttempts = input.maxAttempts ?? Number.POSITIVE_INFINITY;
  let attempt = 0;
  let stopped = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  let activeWs: WebSocket | null = null;

  const cancellers = new Map<string, () => void>();

  const handleRequest = async (
    ws: WebSocket,
    frame: Extract<DispatchFrame, { type: "request" }>,
  ): Promise<void> => {
    const ac = new AbortController();
    cancellers.set(frame.reqId, () => ac.abort());

    try {
      // Streaming routes: any `/_sandbox/<handle>/<...>` path. The handler's
      // `handleStream` yields `{type: "raw-chunk", data}` for body bytes; the
      // cluster's `dispatchToDaemon` reassembles them. (See task 11.)
      const isStreamingSandboxPath = /^\/_sandbox\/[^/]+\//.test(frame.path);
      if (isStreamingSandboxPath) {
        ws.send(
          encodeFrame({
            type: "headers",
            reqId: frame.reqId,
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          }),
        );
        try {
          for await (const ev of input.controlHandler.handleStream(frame)) {
            if (ac.signal.aborted) break;
            // `ev.data` is already a string (raw body chunk text); pass through.
            ws.send(
              encodeFrame({
                type: "chunk",
                reqId: frame.reqId,
                data: ev.data,
              }),
            );
          }
          ws.send(encodeFrame({ type: "end", reqId: frame.reqId }));
        } catch (err) {
          ws.send(
            encodeFrame({
              type: "error",
              reqId: frame.reqId,
              code: "stream_error",
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }

      const res = await input.controlHandler.handle(frame);
      ws.send(
        encodeFrame({
          type: "headers",
          reqId: frame.reqId,
          status: res.status,
          headers: res.headers ?? {},
        }),
      );
      if (res.body !== undefined && res.body.length > 0) {
        ws.send(
          encodeFrame({
            type: "chunk",
            reqId: frame.reqId,
            data: res.body,
          }),
        );
      }
      ws.send(encodeFrame({ type: "end", reqId: frame.reqId }));
    } finally {
      cancellers.delete(frame.reqId);
    }
  };

  const runOnce = async (): Promise<{ shouldReconnect: boolean }> => {
    attempt += 1;
    return new Promise<{ shouldReconnect: boolean }>((resolve) => {
      const ws = new WebSocket(input.url, {
        headers: { authorization: `Bearer ${input.accessToken}` },
      } as unknown as string);
      activeWs = ws;

      ws.addEventListener("open", () => {
        ws.send(
          encodeFrame({
            type: "hello",
            previewPort: input.hello.previewPort,
            machineId: input.hello.machineId,
            ...(input.hello.hostname ? { hostname: input.hello.hostname } : {}),
            cliVersion: input.hello.cliVersion,
            capabilities: input.hello.capabilities,
          }),
        );
        input.onConnected?.();
      });

      ws.addEventListener("message", (ev) => {
        const text =
          typeof ev.data === "string"
            ? ev.data
            : new TextDecoder().decode(ev.data as ArrayBuffer);
        let frame: DispatchFrame;
        try {
          frame = decodeFrame(text);
        } catch {
          return;
        }
        if (frame.type === "request") {
          void handleRequest(ws, frame);
        } else if (frame.type === "cancel") {
          cancellers.get(frame.reqId)?.();
        }
      });

      ws.addEventListener("close", (ev) => {
        activeWs = null;
        if (stopped) {
          resolve({ shouldReconnect: false });
          return;
        }
        resolve({ shouldReconnect: shouldReconnectOnClose(ev.code) });
      });
      ws.addEventListener("error", () => {
        // Browser-WS error event has no useful info; close handler picks up.
      });
    });
  };

  void (async () => {
    while (!stopped && attempt < maxAttempts) {
      const { shouldReconnect } = await runOnce();
      if (stopped || !shouldReconnect) break;
      await new Promise((r) => setTimeout(r, computeBackoffMs(attempt)));
    }
    resolveClosed();
  })();

  return {
    async close() {
      stopped = true;
      activeWs?.close(1000, "shutdown");
      await closed;
    },
    closed,
  };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `bun test apps/mesh/src/link-daemon/cluster-connection.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/cluster-connection.ts apps/mesh/src/link-daemon/cluster-connection.test.ts
git commit -m "feat(link-daemon): cluster WebSocket connection with reconnect"
```

---

## Task 13: Daemon local ingress

**Files:**
- Create: `apps/mesh/src/link-daemon/local-ingress.ts`
- Test: `apps/mesh/src/link-daemon/local-ingress.test.ts`

The local ingress is a `Bun.serve` that listens on a configurable port and routes by Host header (using `parseHandleFromHost` from task 2) to the right local sandbox. HTTP requests are proxied via `fetch()`; WebSocket upgrades are bridged.

- [ ] **Step 1: Write the failing test (HTTP proxying)**

```ts
// apps/mesh/src/link-daemon/local-ingress.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { startLocalIngress, type LocalIngress } from "./local-ingress";

let ingress: LocalIngress | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
afterEach(async () => {
  await ingress?.stop();
  upstream?.stop(true);
  ingress = null;
  upstream = null;
});

describe("local-ingress HTTP proxying", () => {
  test("routes <handle>.localhost to the sandbox port", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(`hello from ${new URL(req.url).pathname}`, {
          status: 200,
        });
      },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: (handle) =>
        handle === "abc" ? upstream!.port : null,
    });
    const res = await fetch(`http://127.0.0.1:${ingress.port}/widget`, {
      headers: { host: `abc.localhost:${ingress.port}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from /widget");
  });

  test("unknown handle → 404", async () => {
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => null,
    });
    const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
      headers: { host: `nope.localhost:${ingress.port}` },
    });
    expect(res.status).toBe(404);
  });

  test("non-localhost host → 404", async () => {
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => 1,
    });
    const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
      headers: { host: `evil.example.com:${ingress.port}` },
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test apps/mesh/src/link-daemon/local-ingress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement HTTP proxying**

```ts
// apps/mesh/src/link-daemon/local-ingress.ts
/**
 * Local ingress on the user's machine. Single Bun.serve on a configurable
 * port. Routes by Host header: `<handle>.localhost[:port]` → the sandbox's
 * local HTTP port. HTTP and WebSocket upgrades are both proxied.
 *
 * No auth — same posture as `bun dev` / local-docker; the listener is
 * 127.0.0.1-only.
 */
import { parseHandleFromHost } from "./host-parser";

export interface StartLocalIngressInput {
  port: number;
  lookupSandboxPort: (handle: string) => number | null;
}

export interface LocalIngress {
  port: number;
  stop(): Promise<void>;
}

export async function startLocalIngress(
  input: StartLocalIngressInput,
): Promise<LocalIngress> {
  const server = Bun.serve({
    port: input.port,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const host = req.headers.get("host");
      const handle = parseHandleFromHost(host);
      if (!handle) return new Response("not found", { status: 404 });
      const sandboxPort = input.lookupSandboxPort(handle);
      if (!sandboxPort) return new Response("unknown handle", { status: 404 });

      // WebSocket upgrade: defer to websocket handlers below.
      if (req.headers.get("upgrade") === "websocket") {
        const ok = srv.upgrade(req, { data: { sandboxPort } });
        if (!ok) return new Response("ws upgrade failed", { status: 400 });
        return undefined as unknown as Response;
      }

      const url = new URL(req.url);
      const target = `http://127.0.0.1:${sandboxPort}${url.pathname}${url.search}`;
      const headers = new Headers(req.headers);
      headers.set("host", `127.0.0.1:${sandboxPort}`);
      return fetch(target, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
      });
    },
    websocket: {
      async open(ws) {
        // The HTTP fetch handler stashed sandboxPort.
        const { sandboxPort } = ws.data as { sandboxPort: number };
        const upstream = new WebSocket(`ws://127.0.0.1:${sandboxPort}`);
        (ws as unknown as { upstream: WebSocket }).upstream = upstream;
        upstream.addEventListener("message", (e) => {
          try {
            ws.send(e.data as string);
          } catch {
            /* */
          }
        });
        upstream.addEventListener("close", () => {
          try {
            ws.close();
          } catch {
            /* */
          }
        });
      },
      message(ws, raw) {
        const upstream = (ws as unknown as { upstream?: WebSocket }).upstream;
        try {
          upstream?.send(typeof raw === "string" ? raw : new Uint8Array(raw));
        } catch {
          /* */
        }
      },
      close(ws) {
        const upstream = (ws as unknown as { upstream?: WebSocket }).upstream;
        try {
          upstream?.close();
        } catch {
          /* */
        }
      },
    },
  });

  return {
    port: server.port,
    async stop() {
      server.stop(true);
    },
  };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `bun test apps/mesh/src/link-daemon/local-ingress.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the WebSocket proxying test**

Append to `apps/mesh/src/link-daemon/local-ingress.test.ts`:

```ts
describe("local-ingress WS proxying", () => {
  test("forwards WebSocket frames in both directions", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req);
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: {
        message(ws, msg) {
          ws.send(`echo:${typeof msg === "string" ? msg : ""}`);
        },
        open() {},
        close() {},
      },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port,
    });
    const ws = new WebSocket(`ws://abc.localhost:${ingress.port}/`);
    const got: string[] = [];
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.addEventListener("message", (e) => {
      got.push(typeof e.data === "string" ? e.data : "");
    });
    ws.send("hi");
    for (let i = 0; i < 40 && got.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(got[0]).toBe("echo:hi");
    ws.close();
  });
});
```

- [ ] **Step 6: Run the test, expect pass**

Run: `bun test apps/mesh/src/link-daemon/local-ingress.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/local-ingress.ts apps/mesh/src/link-daemon/local-ingress.test.ts
git commit -m "feat(link-daemon): local ingress with Host-based HTTP+WS proxying"
```

---

## Task 14: Rewire `link-daemon/index.ts` (full daemon entry point)

**Files:**
- Modify: `apps/mesh/src/link-daemon/index.ts` (full rewrite)
- Modify: `apps/mesh/src/link-daemon/user-desktop-provider.ts` (remove `openDaemonTunnel`, `tunnel` field, `SandboxState.tunnel`)
- Modify: `apps/mesh/src/cli/commands/link.ts` (drop `noTunnel`)
- Modify: `apps/mesh/src/cli.ts` (drop `--no-tunnel`)

This task does the big rewire: the daemon entry point now wires `cluster-connection` + `local-ingress` + the in-process control handler together.

- [ ] **Step 1: Update `user-desktop-provider.ts`**

In `apps/mesh/src/link-daemon/user-desktop-provider.ts`:
- Remove the `import type { TunnelHandle } from "./tunnel"`.
- Remove `tunnel: TunnelHandle | null` from `SandboxState` (line 53) and `sandboxApiUrl` derivation; `sandboxApiUrl` becomes `http://127.0.0.1:${port}`.
- Remove `OpenTunnelDeps` interface entirely (lines 74–80).
- Remove `openDaemonTunnel` from `DesktopSandboxProviderDeps` (lines 95–101).
- In `buildEntry` (lines 189–254): remove the `await deps.openDaemonTunnel(...)` block; set `tunnel: null` is gone; `sandboxApiUrl = http://127.0.0.1:${port}` directly.
- In all the cleanup paths (`evictDead`, `evictIfNeeded`, `deleteSandbox`, `shutdown`, the spawned-exit watchdog): remove `try { tunnel?.close(); } catch {}` blocks.

After these edits run: `bun test apps/mesh/src/link-daemon/user-desktop-provider.test.ts` — the existing test should still pass once you also update its `DesktopSandboxProviderDeps` fake to drop `openDaemonTunnel`. If the existing test was constructed with `openDaemonTunnel: async () => ({...})`, just delete that field.

- [ ] **Step 2: Rewrite `link-daemon/index.ts`**

Replace the full file contents:

```ts
// apps/mesh/src/link-daemon/index.ts
/**
 * Desktop-side link daemon.
 *
 * - Reads session from `<dataDir>/session.json`.
 * - Opens a WebSocket to `<MESH_CLUSTER_URL>/api/links/connect` with the
 *   session bearer; sends the `hello` frame.
 * - Spawns the local ingress on `--port` so browsers can reach
 *   `<handle>.localhost:<port>` for sandbox previews.
 * - Dispatches incoming control-plane requests (sandbox lifecycle + the
 *   harness streaming endpoint) into the in-process handler.
 */
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  postConfig as daemonPostConfig,
  waitForDaemonReady,
} from "@decocms/sandbox/daemon-client";
import { createDefaultDaemonSpawn } from "@decocms/sandbox/daemon-spawn";
import { detectCapabilities } from "./capabilities";
import { createControlHandler } from "./control-handler";
import { connectToCluster } from "./cluster-connection";
import { startLocalIngress } from "./local-ingress";
import { loadOrCreateMachineId } from "./machine-id";
import { readSession } from "./session";
import {
  createDesktopSandboxProvider,
  type SpawnResult,
} from "./user-desktop-provider";

export interface StartLinkDaemonOptions {
  port: number;
  clusterBaseUrl: string;
  dataDir: string;
}

export interface LinkDaemonHandle {
  stopped: Promise<number>;
  stop: () => Promise<void>;
}

export async function startLinkDaemon(
  opts: StartLinkDaemonOptions,
): Promise<LinkDaemonHandle> {
  const session = await readSession(opts.dataDir);
  if (!session) {
    throw new Error(
      "No session found. Run `deco auth login` first, then re-run `deco link`.",
    );
  }

  const machineId = await loadOrCreateMachineId(opts.dataDir);
  const cliVersion = process.env.npm_package_version ?? "0.0.0";
  const hostname = osHostname() || undefined;

  const innerSpawn = createDefaultDaemonSpawn(opts.dataDir);
  const provider = createDesktopSandboxProvider({
    dataDir: opts.dataDir,
    spawnDaemon: (args): Promise<SpawnResult> => {
      const env: Record<string, string> = {
        DAEMON_BOOT_ID: randomUUID(),
        APP_ROOT: args.workdir,
        PROXY_PORT: String(args.port),
      };
      return innerSpawn({ workdir: args.workdir, env, daemonPort: args.port }).then(
        (proc) => ({
          port: args.port,
          kill: (sig) => proc.kill(sig),
          exited: proc.exited.then(() => undefined),
        }),
      );
    },
    postConfig: async (port, devPort, config) => {
      // Daemon's TenantConfig wire shape is `{ git, application }`.
      const payload: Record<string, unknown> = { application: { port: devPort } };
      if (config.repo) {
        payload.git = {
          repository: {
            cloneUrl: config.repo.cloneUrl,
            branch: config.repo.branch,
          },
          ...(config.repo.userName && config.repo.userEmail
            ? {
                identity: {
                  userName: config.repo.userName,
                  userEmail: config.repo.userEmail,
                },
              }
            : {}),
        };
      }
      await daemonPostConfig(`http://127.0.0.1:${port}`, "", payload);
    },
    waitForHealth: async (port) => {
      await waitForDaemonReady(`http://127.0.0.1:${port}`);
    },
    maxSandboxes: 20,
  });

  const ingress = await startLocalIngress({
    port: opts.port,
    lookupSandboxPort: (handle) => provider.proxyPort(handle),
  });
  console.log(
    `Local ingress listening on http://127.0.0.1:${ingress.port} (use http://<handle>.localhost:${ingress.port}/)`,
  );

  // The control handler reverse-proxies `/_sandbox/<handle>/*` to each
  // spawned sandbox daemon's local port. The provider exposes `proxyPort` and
  // `acquireDispatch` to map handle → port and track in-flight calls.
  const controlHandler = createControlHandler({ provider });

  const wsUrl = (() => {
    const u = new URL("/api/links/connect", opts.clusterBaseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  })();

  const cluster = await connectToCluster({
    url: wsUrl,
    accessToken: session.accessToken,
    hello: {
      previewPort: ingress.port,
      machineId,
      hostname,
      cliVersion,
      capabilities: await detectCapabilities(),
    },
    controlHandler,
    onConnected: () => console.log(`Linked to ${opts.clusterBaseUrl}`),
  });

  let resolveStopped!: (code: number) => void;
  const stopped = new Promise<number>((r) => {
    resolveStopped = r;
  });
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down…");
    try {
      await cluster.close();
    } catch {
      /* */
    }
    try {
      await ingress.stop();
    } catch {
      /* */
    }
    try {
      await provider.shutdown();
    } catch {
      /* */
    }
    resolveStopped(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  void cluster.closed.then(() => {
    if (!shuttingDown) {
      console.error("Cluster connection closed permanently; exiting.");
      void shutdown();
    }
  });

  return { stopped, stop: shutdown };
}
```

- [ ] **Step 3: Drop `noTunnel` from `link.ts`**

Modify `apps/mesh/src/cli/commands/link.ts`:

```ts
// Replace the existing LinkCommandOptions + runLinkCommand
export interface LinkCommandOptions {
  port?: number;
  clusterBaseUrl?: string;
  dataDir?: string;
}

export async function runLinkCommand(
  opts: LinkCommandOptions = {},
): Promise<number> {
  const port = opts.port ?? 5174;
  const dataDir =
    opts.dataDir ??
    process.env.DATA_DIR ??
    process.env.DECOCMS_HOME ??
    join(homedir(), "deco");
  const clusterBaseUrl =
    opts.clusterBaseUrl ??
    process.env.MESH_CLUSTER_URL ??
    "https://studio.decocms.com";

  try {
    const handle = await startLinkDaemon({ port, clusterBaseUrl, dataDir });
    return handle.stopped;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
```

- [ ] **Step 4: Drop `--no-tunnel` from `cli.ts`**

In `apps/mesh/src/cli.ts` (lines 63–66):

```ts
// Delete:
"no-tunnel": {
  type: "boolean",
  default: false,
},
```

Also remove `--no-tunnel` from the help text in the same file.

- [ ] **Step 5: Run the unit tests**

```bash
bun test apps/mesh/src/link-daemon/
bun run check
```

Expected: existing daemon tests pass (modulo deletion of `tunnel.test.ts` in task 16). Type errors will appear from still-existing references to the old surface — that's task 16.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/index.ts apps/mesh/src/link-daemon/user-desktop-provider.ts apps/mesh/src/cli/commands/link.ts apps/mesh/src/cli.ts
git commit -m "feat(link-daemon): rewire daemon to use WS+NATS transport and local ingress"
```

---

## Task 15: Replace `routes.ts` with a small `GET /api/links/me` and delete write endpoints

**Files:**
- Modify: `apps/mesh/src/links/ws-gateway.ts` — add a `GET /api/links/me` handler that reads from the claim registry
- Delete: `apps/mesh/src/links/routes.ts`
- Delete: `apps/mesh/src/links/routes.test.ts`
- Modify: `apps/mesh/src/api/app.ts` — drop `registerLinksRoutes` import + call (already replaced by `registerLinksGateway` in task 7)

- [ ] **Step 1: Add `GET /api/links/me` to `ws-gateway.ts`**

Append inside `registerLinksGateway`, after the WS route:

```ts
  app.get("/api/links/me", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    let userSub: string | null = null;
    if (match) {
      userSub = await deps.validateBearer(match[1].trim());
    } else {
      // Fall back to existing meshContext (session cookie).
      const ctx = (c.get as any)("meshContext");
      userSub = ctx?.auth?.user?.id ?? null;
    }
    if (!userSub) return c.json({ error: "unauthorized" }, 401);
    const claim = await deps.registry.get(userSub);
    if (!claim) return c.json(null);
    return c.json({
      machineId: claim.machineId,
      hostname: claim.hostname,
      cliVersion: claim.cliVersion,
      previewPort: claim.previewPort,
      connectedAt: claim.connectedAt,
    });
  });
```

- [ ] **Step 2: Add a test for `GET /api/links/me`**

Append to `apps/mesh/src/links/ws-gateway.test.ts`:

```ts
describe("GET /api/links/me", () => {
  test("returns null when no claim", async () => {
    const app = new Hono();
    registerLinksGateway(app, {
      registry,
      nats: makeFakeNatsAdapter(),
      validateBearer: async () => "user-1",
      podId: "pod",
    });
    const res = await app.request("/api/links/me", {
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test("returns claim fields when present", async () => {
    const app = new Hono();
    registerLinksGateway(app, {
      registry,
      nats: makeFakeNatsAdapter(),
      validateBearer: async () => "user-1",
      podId: "pod",
    });
    await registry.put("user-1", {
      podId: "pod",
      machineId: "m",
      cliVersion: "1.0.0",
      previewPort: 5174,
      connectedAt: 1,
    });
    const res = await app.request("/api/links/me", {
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      machineId: "m",
      cliVersion: "1.0.0",
      previewPort: 5174,
      connectedAt: 1,
    });
  });
});
```

- [ ] **Step 3: Run the test**

Run: `bun test apps/mesh/src/links/ws-gateway.test.ts`
Expected: PASS.

- [ ] **Step 4: Delete `routes.ts` and `routes.test.ts`**

```bash
rm apps/mesh/src/links/routes.ts apps/mesh/src/links/routes.test.ts
```

- [ ] **Step 5: Remove imports/calls of `registerLinksRoutes` in `app.ts`**

Search for the import line and the call (look near lines 274–279 you found earlier). Delete them.

- [ ] **Step 6: Typecheck + run tests**

```bash
bun run check
bun test apps/mesh/src/links/
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
bun run fmt
git add -A apps/mesh/src/links/ apps/mesh/src/api/app.ts
git commit -m "refactor(links): replace HTTP routes with WS gateway and GET /me"
```

---

## Task 16: Delete the old surface

**Files:**
- Delete: `apps/mesh/src/link-daemon/tunnel.ts`, `apps/mesh/src/link-daemon/tunnel.test.ts`
- Delete: `apps/mesh/src/link-daemon/registration.ts` (no test)
- Delete: `apps/mesh/src/link-daemon/control-plane.ts`, `apps/mesh/src/link-daemon/control-plane.test.ts`
- Delete: `apps/mesh/src/links/link-registry.ts`, `apps/mesh/src/links/link-registry.test.ts`
- Delete: `apps/mesh/src/links/protocol/hmac.ts`, `apps/mesh/src/links/protocol/hmac.test.ts`, `apps/mesh/src/links/protocol/fixtures.ts`
- Delete: `apps/mesh/src/links/loopback.test.ts`, `apps/mesh/src/links/dispatch-loopback.test.ts`, `apps/mesh/src/links/resolve-dispatch-target.test.ts`, `apps/mesh/src/links/cancellation.test.ts`
- Modify: `apps/mesh/src/links/protocol/index.ts` — drop the HMAC re-export
- Modify: `apps/mesh/src/links/protocol/schemas.ts` — drop `tunnelUrl` from `registrationPayloadSchema`, `linkEntrySchema`; drop `linkSecret` from `linkEntrySchema`/`registrationResponseSchema`. (Keep `linkEntrySchema.userId`, `machineId`, `cliVersion`, `hostname`, `capabilities`, `protocolVersion` — they're still useful for `GET /api/links/me`.) Actually, since the GET endpoint now constructs its own shape from `LinkClaim`, delete `linkEntrySchema` and `registrationPayloadSchema` and `registrationResponseSchema` entirely.
- Modify: `apps/mesh/package.json` — remove `@deco-cx/warp-node` from `dependencies`
- Search-and-remove: any remaining `MESH_ALLOW_LOCALHOST_LINKS`, `tunnelUrl`, `linkSecret`, `DAEMON_LINK_SECRET`, `signRequest`, `verifyRequest`, `X-Link-Secret`, `x-link-secret`, `*.deco.host`, `expectedTunnelDomain`, `computeLinkSubDomain`, `isLocalhostUrl`, `--no-tunnel`, `--legacy-tunnel` references.

- [ ] **Step 1: Delete the files**

```bash
rm apps/mesh/src/link-daemon/tunnel.ts apps/mesh/src/link-daemon/tunnel.test.ts
rm apps/mesh/src/link-daemon/registration.ts
rm apps/mesh/src/link-daemon/control-plane.ts apps/mesh/src/link-daemon/control-plane.test.ts
rm apps/mesh/src/links/link-registry.ts apps/mesh/src/links/link-registry.test.ts
rm apps/mesh/src/links/protocol/hmac.ts apps/mesh/src/links/protocol/hmac.test.ts
rm apps/mesh/src/links/protocol/fixtures.ts
rm apps/mesh/src/links/loopback.test.ts apps/mesh/src/links/dispatch-loopback.test.ts apps/mesh/src/links/resolve-dispatch-target.test.ts apps/mesh/src/links/cancellation.test.ts
```

- [ ] **Step 2: Update `protocol/index.ts`**

Replace contents with:

```ts
export * from "./schemas";
export * from "./version";
```

- [ ] **Step 3: Update `protocol/schemas.ts`**

Subagent reads the current file and deletes:
- `registrationPayloadSchema` and its type
- `linkEntrySchema` and its type
- `registrationResponseSchema` and its type
- `dispatchSSEEventSchema` — **KEEP**, used by `remoteDispatch`

Keep `capabilitySchema`, `dispatchSSEEventSchema`, `harnessStreamInputSchema`, `helloPayloadSchema` (added in task 5).

- [ ] **Step 4: Remove `@deco-cx/warp-node` from `package.json`**

```bash
cd apps/mesh && bun remove @deco-cx/warp-node
```

- [ ] **Step 5: Search-and-fix lingering references**

```bash
grep -rln "MESH_ALLOW_LOCALHOST_LINKS\|tunnelUrl\|linkSecret\|DAEMON_LINK_SECRET\|signRequest\|verifyRequest\|X-Link-Secret\|x-link-secret\|expectedTunnelDomain\|computeLinkSubDomain\|isLocalhostUrl\|warp-node\|deco\.host" apps/mesh/src
```

For each hit: delete the line/block, or rewrite to use the new surface. Examples:
- `MESH_ALLOW_LOCALHOST_LINKS` in `app.ts` — delete.
- `tunnelUrl` references in tests — those tests should already be deleted; if any remain, delete them too.
- Documentation comments mentioning `*.deco.host` or `linkSecret` — rewrite.

- [ ] **Step 6: Typecheck and run all unit tests**

```bash
bun run check
bun test apps/mesh/src/
```

Expected: zero type errors, all remaining unit tests pass.

- [ ] **Step 7: Commit**

```bash
bun run fmt
git add -A
git commit -m "chore(links): delete Cloudflare tunnel + HMAC scaffolding"
```

---

## Task 17: Drop the `link_registry` Postgres table

**Files:**
- Create: `apps/mesh/migrations/097-drop-link-registry.ts`

The `link_registry` table backed the old `LinkRegistry` Postgres path; with NATS KV-only storage there's no need for it. Forward-only migration — `down()` is a stub since we have no path back.

- [ ] **Step 1: Check the table exists**

Run from `apps/mesh`:

```bash
ls migrations/ | grep -i link
# Confirm the table is created somewhere in an earlier migration. If
# `link_registry` isn't found, this entire task can be skipped.
```

If `link_registry` is not present in any migration file (it lives in `links/link-registry.ts` only as a NATS KV bucket), skip to step 4 and just commit nothing — there's no Postgres state to drop.

- [ ] **Step 2: Write the migration**

```ts
// apps/mesh/migrations/097-drop-link-registry.ts
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("link_registry").ifExists().execute();
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Forward-only — recreating the dropped schema would require recreating
  // every column type and FK, and there's no use case for rolling back.
}
```

- [ ] **Step 3: Run the migration locally**

```bash
bun run --cwd=apps/mesh migrate
```

Expected: migration applies cleanly. Verify with the local-Postgres-querying recipe in `CLAUDE.md`:

```bash
ps aux | grep "postgres -D" | grep -v grep
# extract the port, then:
cat << 'EOF' | bun run --cwd apps/mesh -
import pg from "pg";
const PORT = <PORT>;
const client = new pg.Client(`postgresql://postgres:postgres@localhost:${PORT}/postgres`);
await client.connect();
const { rows } = await client.query(
  "SELECT to_regclass('public.link_registry') AS t"
);
console.log(rows[0].t); // should be null
await client.end();
EOF
```

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/migrations/097-drop-link-registry.ts
git commit -m "chore(links): drop link_registry Postgres table"
```

---

## Task 18: e2e — happy path dispatch

**Files:**
- Create: `apps/mesh/e2e/tests/link-dispatch-happy.spec.ts`

The subagent should read `apps/mesh/e2e/fixtures/test.ts` first to understand the fixture shape.

- [ ] **Step 1: Write the test**

```ts
// apps/mesh/e2e/tests/link-dispatch-happy.spec.ts
import { test, expect } from "../fixtures/test";
import { startLinkDaemon } from "../../src/link-daemon";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("daemon → mesh dispatch round-trips harness chunks", async ({
  authedPage,
}) => {
  // 1. Read the session that the e2e fixture established (the fixture sets
  // up an authenticated user; we need to grab their access token so the
  // daemon can connect).
  const apiRequest = authedPage.page.context().request;
  // The test rig writes session.json to a known path; if the rig instead
  // uses cookies, mint an API key via `/api/api-keys` and pass it as the
  // daemon's accessToken.
  const dataDir = mkdtempSync(join(tmpdir(), "link-e2e-"));
  // Write a minimal session.json — the API key was minted above, or use
  // the cookie's session token directly. (Adjust to the rig's specifics
  // discovered while reading fixtures/test.ts.)

  // 2. Start the daemon against the e2e cluster URL.
  const daemon = await startLinkDaemon({
    port: 0,
    clusterBaseUrl: process.env.MESH_E2E_CLUSTER_URL ?? "http://localhost:3000",
    dataDir,
  });

  // 3. Drive a harness via the cluster's normal API — for example by
  // visiting the chat UI and starting a run, or by calling the dispatch
  // tool directly.
  // For now we assert the daemon connected successfully (heartbeat-equivalent):
  await expect
    .poll(async () => {
      const res = await apiRequest.get("/api/links/me");
      const body = await res.json();
      return body?.previewPort != null;
    })
    .toBe(true);

  await daemon.stop();
});
```

This test is intentionally lightweight in v1. A fuller test invokes a real harness, but that requires plumbing — the subagent should expand once the daemon-side dispatch wiring is fully done.

- [ ] **Step 2: Run the test against a live dev stack**

Run `bun run dev` in one terminal first. Then:

```bash
bun run --cwd=apps/mesh playwright test e2e/tests/link-dispatch-happy.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/e2e/tests/link-dispatch-happy.spec.ts
git commit -m "test(e2e): link daemon happy-path dispatch"
```

---

## Task 19: e2e — eviction

**Files:**
- Create: `apps/mesh/e2e/tests/link-dispatch-eviction.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// apps/mesh/e2e/tests/link-dispatch-eviction.spec.ts
import { test, expect } from "../fixtures/test";
import { startLinkDaemon } from "../../src/link-daemon";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("second daemon connection evicts the first", async ({ authedPage }) => {
  const apiRequest = authedPage.page.context().request;
  const dirA = mkdtempSync(join(tmpdir(), "link-e2e-A-"));
  const dirB = mkdtempSync(join(tmpdir(), "link-e2e-B-"));

  const a = await startLinkDaemon({
    port: 0,
    clusterBaseUrl: process.env.MESH_E2E_CLUSTER_URL ?? "http://localhost:3000",
    dataDir: dirA,
  });
  await expect
    .poll(async () => (await (await apiRequest.get("/api/links/me")).json()))
    .not.toBeNull();
  const firstClaim = await (await apiRequest.get("/api/links/me")).json();

  const b = await startLinkDaemon({
    port: 0,
    clusterBaseUrl: process.env.MESH_E2E_CLUSTER_URL ?? "http://localhost:3000",
    dataDir: dirB,
  });
  await expect
    .poll(async () => {
      const c = await (await apiRequest.get("/api/links/me")).json();
      return c?.machineId !== firstClaim.machineId;
    })
    .toBe(true);

  // a.stopped should resolve shortly: its WS got closed with 4001.
  await a.stopped;
  await b.stop();
});
```

- [ ] **Step 2: Run**

```bash
bun run --cwd=apps/mesh playwright test e2e/tests/link-dispatch-eviction.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/e2e/tests/link-dispatch-eviction.spec.ts
git commit -m "test(e2e): link daemon eviction"
```

---

## Task 20: e2e — auth rejection and local ingress proxy

**Files:**
- Create: `apps/mesh/e2e/tests/link-dispatch-auth.spec.ts`
- Create: `apps/mesh/e2e/tests/link-local-ingress.spec.ts`

- [ ] **Step 1: Write the auth-rejection test**

```ts
// apps/mesh/e2e/tests/link-dispatch-auth.spec.ts
import { test, expect } from "../fixtures/test";

test("WS upgrade without bearer is rejected", async ({ authedPage }) => {
  const url =
    (process.env.MESH_E2E_CLUSTER_URL ?? "http://localhost:3000").replace(
      /^http/,
      "ws",
    ) + "/api/links/connect";
  const ws = new WebSocket(url);
  const code = await new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code)),
  );
  expect(code).not.toBe(1000);
});

test("WS upgrade with invalid bearer is rejected", async ({ authedPage }) => {
  const url =
    (process.env.MESH_E2E_CLUSTER_URL ?? "http://localhost:3000").replace(
      /^http/,
      "ws",
    ) + "/api/links/connect";
  const ws = new WebSocket(url, {
    headers: { authorization: "Bearer not-real" },
  } as unknown as string);
  const code = await new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code)),
  );
  expect(code).not.toBe(1000);
});
```

- [ ] **Step 2: Write the local-ingress test**

```ts
// apps/mesh/e2e/tests/link-local-ingress.spec.ts
import { test, expect } from "../fixtures/test";
import { startLocalIngress } from "../../src/link-daemon/local-ingress";

test("local ingress routes <handle>.localhost to sandbox", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: () => new Response("hi", { status: 200 }),
  });
  const ingress = await startLocalIngress({
    port: 0,
    lookupSandboxPort: (h) => (h === "abc" ? upstream.port : null),
  });
  const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
    headers: { host: `abc.localhost:${ingress.port}` },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hi");
  await ingress.stop();
  upstream.stop(true);
});

test("unknown handle returns 404", async () => {
  const ingress = await startLocalIngress({
    port: 0,
    lookupSandboxPort: () => null,
  });
  const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
    headers: { host: `nope.localhost:${ingress.port}` },
  });
  expect(res.status).toBe(404);
  await ingress.stop();
});
```

- [ ] **Step 3: Run both**

```bash
bun run --cwd=apps/mesh playwright test e2e/tests/link-dispatch-auth.spec.ts e2e/tests/link-local-ingress.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/e2e/tests/link-dispatch-auth.spec.ts apps/mesh/e2e/tests/link-local-ingress.spec.ts
git commit -m "test(e2e): link auth rejection and local ingress routing"
```

---

## Task 21: Resilience scenarios

**Files:**
- Create: `tests/resilience/scenarios/link-dispatch-nats-disconnect.test.ts`
- Create: `tests/resilience/scenarios/link-dispatch-pod-crash.test.ts`

The subagent reads an existing scenario file (`ls tests/resilience/scenarios/`) to understand the harness. Both new scenarios use the same Docker compose, Toxiproxy, and harness setup as the existing scenarios.

- [ ] **Step 1: Read an existing scenario to mimic structure**

```bash
ls tests/resilience/scenarios/
cat tests/resilience/scenarios/<existing-scenario>.test.ts
```

- [ ] **Step 2: Write `link-dispatch-nats-disconnect.test.ts`**

The shape:
1. Start the full stack via `./tests/resilience/run.sh` or the existing compose.
2. Start a daemon, wait for its claim to appear in `GET /api/links/me`.
3. Use Toxiproxy to sever the NATS connection from one mesh pod.
4. Issue a dispatch from that pod — assert it errors fast (within ~5s) rather than hanging.
5. Restore NATS, assert the next dispatch succeeds.

- [ ] **Step 3: Write `link-dispatch-pod-crash.test.ts`**

Shape:
1. Start the stack with 2 mesh replicas.
2. Start a daemon; verify which pod holds the WS via `kubectl logs` or by `podId` in `GET /api/links/me`.
3. `docker kill` that pod.
4. Daemon's WS should drop and reconnect; the new claim should land on the other pod within ~60s (bucket TTL).
5. Next dispatch succeeds.

The subagent fleshes out the actual code by mirroring existing scenarios. Per the resilience-test convention (`CLAUDE.md`), use `--serial --timeout 900000`.

- [ ] **Step 4: Run**

```bash
./tests/resilience/run.sh
```

Expected: both new scenarios pass alongside the existing suite.

- [ ] **Step 5: Commit**

```bash
git add tests/resilience/scenarios/link-dispatch-*.test.ts
git commit -m "test(resilience): link dispatch under NATS disconnect and pod crash"
```

---

## Final sweep

- [ ] **Step 1: Full check**

```bash
bun run check
bun run lint
bun run fmt:check
bun test apps/mesh/src/
```

Expected: all clean.

- [ ] **Step 2: Confirm no `*.deco.host` / `warp-node` / `linkSecret` lingerers**

```bash
grep -rn "deco\.host\|warp-node\|linkSecret\|tunnelUrl\|MESH_ALLOW_LOCALHOST_LINKS\|--no-tunnel" apps/mesh/src packages/sandbox
```

Expected: no output (or only matches inside the spec/plan markdown files in `docs/`).

- [ ] **Step 3: Confirm package.json no longer depends on warp-node**

```bash
grep "warp-node" apps/mesh/package.json
```

Expected: no output.

- [ ] **Step 4: Final commit if anything turned up**

```bash
bun run fmt
git add -A
git commit -m "chore(links): final sweep of legacy tunnel references"
```

- [ ] **Step 5: Push the branch**

(Only if the user has authorized push; otherwise stop here and report.)

```bash
git push -u origin tlgimenes/decocms-link-warp-tunnel
```

---

## Notes for reviewers / implementer

1. **NATS subject sizing.** The control-plane dispatches are small JSON. NATS default 1MB limit is well above what we'll see for these. If a harness ever emits a chunk over 1MB (unlikely — these are LLM tokens), we'd need to split it at the daemon side. Defer until measured.

2. **Better Auth API exact shape.** Task 7 assumes `auth.api.getSession({ headers })`. Confirm by grepping for existing call sites (`grep -rn "auth.api.getSession" apps/mesh/src/`). If the codebase uses a different helper (e.g., `betterAuth.session.fromBearer(token)`), substitute it in `validateBearer`.

3. **Bun WebSocket library nuances.** Bun's `new WebSocket(url, { headers })` shape is non-standard (the DOM spec doesn't allow a second arg). If the runtime rejects this, fall back to opening a raw `fetch` upgrade request and reading the `webSocket` from the response. Try the simple form first.

4. **Bun.serve `c.env.server` access pattern.** Hono on Bun doesn't natively expose the server in the context. The fetch handler in task 7 does `app.fetch(req, { server: srv })` — the second arg becomes `c.env` inside Hono. If your Hono version drops the second arg into bindings instead, adjust. The subagent can verify with a quick "what is `c.env` in this Hono version" check.

5. **Scope limits.** This plan does NOT implement the future "publish my preview to the internet" flow we deferred in the spec. That's a separate plan when/if it becomes a product need.
