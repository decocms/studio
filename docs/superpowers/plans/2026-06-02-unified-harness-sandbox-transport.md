# Unified harness/sandbox transport + message offload-by-reference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `MAX_PAYLOAD_EXCEEDED` on the user-desktop link by offloading the dispatch `messages[]` to object storage by reference, and unify harness dispatch onto the `SandboxProvider.proxyDaemonRequest` seam.

**Architecture:** The mesh dispatch layer offloads an oversized `messages[]` array to object storage and sends a small `{ messagesRef }` envelope alongside the dispatch body; the daemon's `/dispatch` route fetches and splices it back before running the harness. Harness dispatch is migrated off the raw `DispatchFn` onto `proxyDaemonRequest` so all cluster→daemon traffic flows through one seam. There is **no chunking fallback** for the request body — if offload is impossible, throw.

**Tech stack:** TypeScript, Bun, Zod, NATS (core pub/sub), S3/R2/MinIO object storage, Hono, Vitest/`bun test`, Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-06-02-unified-harness-sandbox-transport-design.md` — read it before starting.

**Testing rules (`TESTING.md`):** Unit tests = pure logic only (no mocks/DB/network). Anything needing object storage, NATS, or a real daemon goes to **e2e** (`apps/mesh/e2e/tests/`, real Postgres+NATS+MinIO). Each task below marks which tier.

---

## File map

**Create:**
- `apps/mesh/src/harnesses/offload-messages.ts` — pure offload decision + envelope build/parse + key derivation.
- `apps/mesh/src/harnesses/offload-messages.test.ts` — unit tests (pure).
- `packages/sandbox/daemon/routes/offload-fetch.ts` — daemon-side SSRF-guarded ref fetcher (pure URL guard + bounded fetch).
- `packages/sandbox/daemon/routes/offload-fetch.test.ts` — unit tests for the URL guard (pure).
- `apps/mesh/src/links/protocol/error-codes.ts` — shared terminal error-code enum.
- `apps/mesh/e2e/tests/link-dispatch-offload.spec.ts` — e2e coverage.

**Modify:**
- `apps/mesh/src/links/protocol/schemas.ts` — extend `capabilitySchema`; per-element-tolerant capabilities.
- `apps/mesh/src/links/dispatch-frames.ts` — make hello `capabilities` per-element tolerant (it consumes `capabilitySchema`).
- `apps/mesh/src/object-storage/bound-object-storage.ts` + `apps/mesh/src/object-storage/s3-service.ts` + `apps/mesh/src/object-storage/dev-object-storage.ts` — add `requireFetchable` to `presignedGetUrl`.
- `apps/mesh/src/harnesses/remote-dispatch.ts` — consume a `Response` (Part A) + emit the offload envelope + cleanup (Part B encode).
- `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` — pass `proxyDaemonRequest` + an offload closure (built from `ctx.objectStorage`) into `remoteDispatch`; read daemon capabilities.
- `packages/sandbox/daemon/routes/dispatch.ts` — re-inflate `messagesRef` inside the SSE stream (headers flush first).
- `apps/mesh/src/api/routes/decopilot/nats-stream-buffer.ts` — import shared `MAX_PUBLISH_BYTES`.
- `apps/mesh/src/services/ensure-services.ts` — auto-provision MinIO in dev (+ bucket + lifecycle rule).
- `packages/sandbox/server/provider/types.ts` (+ both runners) — remove dead `exec`/`ExecInput`/`ExecOutput` (if knip-clean).

---

## Task 1: Share `MAX_PUBLISH_BYTES` (consolidate the constant)

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/nats-stream-buffer.ts`
- Reference: `apps/mesh/src/nats/payload-chunking.ts:16` (the canonical `export const MAX_PUBLISH_BYTES = 768 * 1024`)

- [ ] **Step 1: Find the private copy.** In `nats-stream-buffer.ts`, locate its own `MAX_PUBLISH_BYTES` (or equivalently-named 768 KiB constant).

- [ ] **Step 2: Replace with an import.**

```ts
import { MAX_PUBLISH_BYTES } from "@/nats/payload-chunking";
```

Delete the local declaration; keep the JetStream fragmentation impl (`Dp-Frag-Idx/Total`, 32 MiB cap) untouched — only the constant is shared, not the splitter.

- [ ] **Step 3: Type-check + tests.**

Run: `bun run check && bun test apps/mesh/src/api/routes/decopilot/nats-stream-buffer.test.ts`
Expected: PASS (no behavior change; the value is identical).

- [ ] **Step 4: Commit.**

```bash
git add apps/mesh/src/api/routes/decopilot/nats-stream-buffer.ts
git commit -m "refactor(nats): share MAX_PUBLISH_BYTES constant across chunkers"
```

---

## Task 2: Extend capabilities with `body-offload` (per-element tolerant)

**Why:** `requestFrame` silently strips unknown fields, so an old daemon would reverse-proxy an empty body. Offload is gated on the daemon advertising `body-offload`. The current `capabilities: z.array(capabilitySchema).catch([])` blanks the WHOLE array if any element is unknown — fix to per-element tolerance so version skew never drops known capabilities.

**Files:**
- Modify: `apps/mesh/src/links/protocol/schemas.ts:3-8`
- Modify: `apps/mesh/src/links/dispatch-frames.ts:9-16` (the `helloFrame.capabilities`)
- Test: `apps/mesh/src/links/protocol/schemas.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `schemas.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { capabilitySchema, capabilitiesArraySchema } from "./schemas";

describe("capabilities", () => {
  it("includes body-offload", () => {
    expect(capabilitySchema.safeParse("body-offload").success).toBe(true);
  });
  it("drops unknown elements but keeps known ones (per-element tolerant)", () => {
    expect(capabilitiesArraySchema.parse(["claude-code", "made-up", "body-offload"]))
      .toEqual(["claude-code", "body-offload"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test apps/mesh/src/links/protocol/schemas.test.ts -t capabilities`
Expected: FAIL (`body-offload` not in enum; `capabilitiesArraySchema` not exported).

- [ ] **Step 3: Implement.** In `schemas.ts`:

```ts
export const capabilitySchema = z.enum([
  "claude-code",
  "codex",
  "decopilot-sandbox",
  "body-offload",
]);
export type Capability = z.infer<typeof capabilitySchema>;

// Per-element tolerant: unknown capabilities are dropped, known ones survive.
// (A whole-array `.catch([])` would blank everything on one unknown element
// during version skew.)
export const capabilitiesArraySchema = z
  .array(z.string())
  .catch([])
  .transform((arr) =>
    arr.filter((c): c is Capability => capabilitySchema.safeParse(c).success),
  );
```

In `dispatch-frames.ts`, change the hello frame to use it:

```ts
import { capabilitiesArraySchema } from "./protocol/schemas";
// ...
  capabilities: capabilitiesArraySchema,
```

- [ ] **Step 4: Run to verify it passes.**

Run: `bun test apps/mesh/src/links/protocol/schemas.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/mesh/src/links/protocol/schemas.ts apps/mesh/src/links/dispatch-frames.ts apps/mesh/src/links/protocol/schemas.test.ts
git commit -m "feat(links): add body-offload capability with per-element-tolerant parsing"
```

---

## Task 3: `requireFetchable` option on `presignedGetUrl`

**Why:** Offload needs a real fetchable URL. `DevObjectStorage.presignedGetUrl` returns an inline `data:` URL (useless as a reference). `requireFetchable: true` makes it throw instead, and is a no-op for real `S3Service` (which always returns a fetchable signed URL). Default behavior is unchanged for all existing callers (vision, `GET_PRESIGNED_URL`, `copy_to_sandbox`, `legacyMaterialize`).

**Files:**
- Modify: `apps/mesh/src/object-storage/bound-object-storage.ts:39,62-63`
- Modify: `apps/mesh/src/object-storage/s3-service.ts:238-249`
- Modify: `apps/mesh/src/object-storage/dev-object-storage.ts:197-203`
- Test: `apps/mesh/src/object-storage/dev-object-storage.test.ts` (create if absent — pure: it reads/writes the local data dir; if that counts as IO, put the throw-assertion in a tiny pure guard function instead — see Step 3)

- [ ] **Step 1: Write the failing test (pure).** The fetchability decision is pure — extract it. Create `apps/mesh/src/object-storage/fetchable.ts` test `fetchable.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { assertFetchableUrl } from "./fetchable";

describe("assertFetchableUrl", () => {
  it("passes through an http(s) url", () => {
    expect(assertFetchableUrl("https://s3.example.com/x")).toBe("https://s3.example.com/x");
  });
  it("throws on a data: url", () => {
    expect(() => assertFetchableUrl("data:image/png;base64,AAAA")).toThrow(/not fetchable/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test apps/mesh/src/object-storage/fetchable.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the pure guard + wire it.** Create `apps/mesh/src/object-storage/fetchable.ts`:

```ts
/** Reject a URL that cannot be fetched by a remote daemon (e.g. a DevObjectStorage
 *  inline `data:` URL). Used by the offload path's `requireFetchable` presign. */
export function assertFetchableUrl(url: string): string {
  if (url.startsWith("data:")) {
    throw new Error(
      "object storage returned a non-fetchable (data:) URL; configure real S3/R2/MinIO for large-payload offload",
    );
  }
  return url;
}
```

Extend the interface in `bound-object-storage.ts`:

```ts
  presignedGetUrl(
    key: string,
    expiresIn?: number,
    opts?: { requireFetchable?: boolean },
  ): Promise<string>;
```

and the impl:

```ts
    presignedGetUrl: (key, expiresIn, opts) =>
      s3.presignedGetUrl(orgId, key, expiresIn, opts),
```

In `s3-service.ts`, add the optional param (no behavior change — a signed S3/R2/MinIO URL is always fetchable):

```ts
  async presignedGetUrl(
    orgId: string,
    key: string,
    expiresIn = 3600,
    _opts?: { requireFetchable?: boolean },
  ): Promise<string> { /* unchanged body */ }
```

In `dev-object-storage.ts`, honor it:

```ts
  async presignedGetUrl(
    key: string,
    _expiresIn?: number,
    opts?: { requireFetchable?: boolean },
  ): Promise<string> {
    if (opts?.requireFetchable) {
      // Dev inline data: URLs are not fetchable by a remote daemon.
      return assertFetchableUrl("data:placeholder"); // always throws
    }
    /* unchanged data: URL body */
  }
```

(Import `assertFetchableUrl` in `dev-object-storage.ts`.)

- [ ] **Step 4: Run to verify it passes + type-check.**

Run: `bun test apps/mesh/src/object-storage/fetchable.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/mesh/src/object-storage/fetchable.ts apps/mesh/src/object-storage/fetchable.test.ts apps/mesh/src/object-storage/bound-object-storage.ts apps/mesh/src/object-storage/s3-service.ts apps/mesh/src/object-storage/dev-object-storage.ts
git commit -m "feat(object-storage): requireFetchable option on presignedGetUrl"
```

---

## Task 4: Pure offload module — decision, envelope, key

**Why:** Keep the offload *logic* pure and unit-testable; the IO (PUT/presign/fetch) is injected and exercised in e2e.

**Files:**
- Create: `apps/mesh/src/harnesses/offload-messages.ts`
- Create: `apps/mesh/src/harnesses/offload-messages.test.ts`
- Reference: `apps/mesh/src/nats/payload-chunking.ts` (`MAX_PUBLISH_BYTES`)

- [ ] **Step 1: Write the failing test (pure).**

```ts
import { describe, it, expect } from "bun:test";
import {
  offloadKey,
  shouldOffload,
  parseMessagesRef,
  type MessagesRef,
} from "./offload-messages";

describe("offload-messages (pure)", () => {
  it("keys by reqId under the ephemeral prefix", () => {
    expect(offloadKey("req-123")).toBe("link-dispatch/req-123");
  });
  it("offloads only above the byte budget", () => {
    expect(shouldOffload(100)).toBe(false);
    expect(shouldOffload(768 * 1024 + 1)).toBe(true);
  });
  it("round-trips a messagesRef envelope", () => {
    const ref: MessagesRef = { url: "https://s/x", bytes: 5, sha256: "ab" };
    const env = { harnessId: "claude-code", input: { a: 1 }, messagesRef: ref };
    expect(parseMessagesRef(env)).toEqual(ref);
    expect(parseMessagesRef({ harnessId: "x", input: {} })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test apps/mesh/src/harnesses/offload-messages.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.**

```ts
import { MAX_PUBLISH_BYTES } from "@/nats/payload-chunking";

export interface MessagesRef {
  url: string;
  bytes: number;
  sha256: string;
}

/** Envelope the daemon's /dispatch route receives. `messagesRef`, when present,
 *  means `input.messages` was offloaded and must be fetched + spliced back. */
export interface DispatchEnvelope {
  harnessId: string;
  input: unknown;
  messagesRef?: MessagesRef;
}

/** Ephemeral key prefix; a bucket lifecycle rule reclaims `*/link-dispatch/`.
 *  The org segment is implicit — BoundObjectStorage prepends `<orgId>/`. */
export function offloadKey(reqId: string): string {
  return `link-dispatch/${reqId}`;
}

/** Offload only when the encoded body would exceed the per-message budget. */
export function shouldOffload(encodedBodyBytes: number): boolean {
  return encodedBodyBytes > MAX_PUBLISH_BYTES;
}

export function parseMessagesRef(env: unknown): MessagesRef | null {
  if (env && typeof env === "object" && "messagesRef" in env) {
    const r = (env as { messagesRef?: unknown }).messagesRef;
    if (
      r && typeof r === "object" &&
      typeof (r as MessagesRef).url === "string" &&
      typeof (r as MessagesRef).bytes === "number" &&
      typeof (r as MessagesRef).sha256 === "string"
    ) {
      return r as MessagesRef;
    }
  }
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `bun test apps/mesh/src/harnesses/offload-messages.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/mesh/src/harnesses/offload-messages.ts apps/mesh/src/harnesses/offload-messages.test.ts
git commit -m "feat(harnesses): pure message-offload decision + envelope module"
```

---

## Task 5: Daemon-side SSRF-guarded ref fetcher

**Why:** The daemon fetches the offloaded `messages` from a presigned URL. Guard against SSRF (host allowlist from config, not the frame), enforce a byte cap + deadline, reject `data:`/non-HTTPS/private hosts (except a documented same-host dev exception), and validate `sha256`.

**Files:**
- Create: `packages/sandbox/daemon/routes/offload-fetch.ts`
- Create: `packages/sandbox/daemon/routes/offload-fetch.test.ts`
- Reference: `packages/sandbox/daemon/routes/fs.ts:405-474` (the `write_from_url` fetch guards + `MAX_TRANSFER_BYTES` pattern) and `control-handler.ts:185` (`redirect:"manual"`).

- [ ] **Step 1: Write the failing test (pure URL guard).**

```ts
import { describe, it, expect } from "bun:test";
import { assertAllowedRefUrl } from "./offload-fetch";

const ALLOW = ["s3.amazonaws.com", "minio.local"];
describe("assertAllowedRefUrl", () => {
  it("allows an https host on the allowlist", () => {
    expect(() => assertAllowedRefUrl("https://s3.amazonaws.com/b/k", ALLOW, false)).not.toThrow();
  });
  it("rejects an off-allowlist host", () => {
    expect(() => assertAllowedRefUrl("https://evil.com/k", ALLOW, false)).toThrow(/host not allowed/i);
  });
  it("rejects data: and non-https", () => {
    expect(() => assertAllowedRefUrl("data:x", ALLOW, false)).toThrow();
    expect(() => assertAllowedRefUrl("http://s3.amazonaws.com/k", ALLOW, false)).toThrow(/https/i);
  });
  it("allows http loopback only when same-host dev is enabled", () => {
    expect(() => assertAllowedRefUrl("http://127.0.0.1:9000/k", ["127.0.0.1"], true)).not.toThrow();
    expect(() => assertAllowedRefUrl("http://127.0.0.1:9000/k", ["127.0.0.1"], false)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test packages/sandbox/daemon/routes/offload-fetch.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.**

```ts
import { retry } from "@decocms/std";

/** Max size of an offloaded messages blob (bound to a realistic harness input,
 *  not a generic 500MiB transfer). */
export const MAX_OFFLOAD_BYTES = 32 * 1024 * 1024;

export function assertAllowedRefUrl(
  raw: string,
  allowedHosts: string[],
  allowSameHostDev: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("offload ref: malformed URL");
  }
  const isHttps = url.protocol === "https:";
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";
  if (allowSameHostDev && url.protocol === "http:" && isLoopback) {
    // dev: same-host MinIO over loopback is allowed.
  } else if (!isHttps) {
    throw new Error("offload ref: only https is allowed");
  }
  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`offload ref: host not allowed (${url.hostname})`);
  }
  return url;
}

/** Fetch the offloaded messages JSON with a deadline, size cap, manual redirect,
 *  and bounded retry. `allowedHosts`/`allowSameHostDev` come from daemon config
 *  (the hello/config channel), NEVER from the request frame. */
export async function fetchOffloadedMessages(
  rawUrl: string,
  opts: { allowedHosts: string[]; allowSameHostDev: boolean; deadlineMs?: number },
): Promise<unknown> {
  assertAllowedRefUrl(rawUrl, opts.allowedHosts, opts.allowSameHostDev);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.deadlineMs ?? 30_000);
  try {
    const res = await retry(
      async () => {
        const r = await fetch(rawUrl, { redirect: "manual", signal: ac.signal });
        if (!r.ok) {
          const err = new Error(`offload fetch ${r.status}`);
          (err as { status?: number }).status = r.status;
          throw err;
        }
        return r;
      },
      { maxAttempts: 3, isRetriable: (e) => {
          const s = (e as { status?: number }).status;
          return s === undefined || s >= 500;
        } },
    );
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_OFFLOAD_BYTES) throw new Error("offload ref: too large");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_OFFLOAD_BYTES) throw new Error("offload ref: too large");
    return JSON.parse(new TextDecoder().decode(buf));
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `bun test packages/sandbox/daemon/routes/offload-fetch.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/sandbox/daemon/routes/offload-fetch.ts packages/sandbox/daemon/routes/offload-fetch.test.ts
git commit -m "feat(daemon): SSRF-guarded offloaded-messages fetcher"
```

---

## Task 6: Daemon `/dispatch` re-inflate (headers-first, then fetch + splice)

**Why:** When the envelope carries `messagesRef`, the daemon must fetch it, splice `input.messages`, then validate and run. Crucially, the SSE `200` headers must flush **before** the (slow) fetch, so the cluster's 30 s first-reply timer is satisfied. So validation + lookup + fetch move *inside* the `ReadableStream.start()`.

**Files:**
- Modify: `packages/sandbox/daemon/routes/dispatch.ts:75-191`
- Reference: Task 5 (`fetchOffloadedMessages`), Task 4 (`parseMessagesRef`); the daemon's config source for `allowedHosts`/`allowSameHostDev` (thread via `DispatchDeps`).

- [ ] **Step 1: Write the failing test (e2e — needs MinIO + a daemon).** Add a placeholder e2e in Task 13; here add a *pure* unit test for the new branch decision in `dispatch.ts` by extracting a helper `needsReinflate(parsed)`:

```ts
// dispatch.reinflate.test.ts
import { describe, it, expect } from "bun:test";
import { parseMessagesRef } from "../../../../apps/mesh/src/harnesses/offload-messages";

describe("dispatch re-inflate detection", () => {
  it("detects a messagesRef envelope", () => {
    expect(parseMessagesRef({ harnessId: "x", input: {}, messagesRef: { url: "u", bytes: 1, sha256: "a" } })).not.toBeNull();
    expect(parseMessagesRef({ harnessId: "x", input: {} })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it passes already** (it reuses Task 4) — this guards the contract the daemon relies on.

Run: `bun test packages/sandbox/daemon/routes/dispatch.reinflate.test.ts`
Expected: PASS.

- [ ] **Step 3: Restructure `handleDispatchRequest`.** Add `allowedHosts: string[]` + `allowSameHostDev: boolean` to `DispatchDeps`. Keep the bearer-token + JSON-parse + `harnessId` checks synchronous (fast → 4xx as today). Then:
  - Detect `messagesRef = parseMessagesRef(parsed)`.
  - **If no `messagesRef`:** keep today's synchronous validate + lookup + 4xx behavior, then stream (unchanged).
  - **If `messagesRef` present:** return the SSE `200` Response *immediately*; do fetch + validate + lookup + stream inside `start(controller)`:

```ts
if (messagesRef) {
  const encoder = new TextEncoder();
  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (e: DispatchSSEEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        const messages = await fetchOffloadedMessages(messagesRef.url, {
          allowedHosts: deps.allowedHosts,
          allowSameHostDev: deps.allowSameHostDev,
        });
        const merged = { ...(parsed.input as object), messages };
        const inputParse = harnessStreamInputSchema.safeParse(merged);
        if (!inputParse.success) { write({ type: "error", code: "bad_input", message: inputParse.error.message }); return; }
        const input = inputParse.data;
        const tomb = tombstones.get(input.runId);
        if (tomb && tomb > Date.now()) { write({ type: "error", code: "tombstoned", message: "cancelled before dispatch" }); return; }
        const ctrl = new AbortController();
        activeRuns.set(input.runId, ctrl);
        let harness;
        try { harness = deps.lookupHarness(parsed.harnessId as string, input); }
        catch (err) { write({ type: "error", code: "unknown_harness", message: err instanceof Error ? err.message : String(err) }); return; }
        try {
          for await (const chunk of harness.stream()) {
            if (ctrl.signal.aborted) break;
            write({ type: "ui-message-chunk", chunk });
          }
        } catch (err) {
          write({ type: "error", code: "harness_crashed", message: err instanceof Error ? err.message : String(err) });
        } finally { activeRuns.delete(input.runId); }
      } catch (err) {
        write({ type: "error", code: "offload_fetch_failed", message: err instanceof Error ? err.message : String(err) });
      } finally {
        write({ type: "done" });
        controller.close();
      }
    },
  });
  return new Response(sseStream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
}
```

Import `fetchOffloadedMessages` (Task 5) and `parseMessagesRef` (Task 4). Wire `allowedHosts`/`allowSameHostDev` from the daemon boot config in `packages/sandbox/daemon/entry.ts` where `handleDispatchRequest` is invoked (`entry.ts:580`).

- [ ] **Step 4: Type-check + existing dispatch tests.**

Run: `bun run check && bun test packages/sandbox/daemon/routes/dispatch.test.ts`
Expected: PASS (non-offload path unchanged).

- [ ] **Step 5: Commit.**

```bash
git add packages/sandbox/daemon/routes/dispatch.ts packages/sandbox/daemon/routes/dispatch.reinflate.test.ts packages/sandbox/daemon/entry.ts
git commit -m "feat(daemon): re-inflate offloaded messages in /dispatch (headers-first)"
```

---

## Task 7: Migrate `remoteDispatch` onto `proxyDaemonRequest` (Part A)

**Why:** Collapse the one cluster→daemon abstraction that bypasses the seam. `remoteDispatch` consumes a `Response` instead of the raw `DispatchChunk` iterator. **Must** preserve two contracts: (a) non-2xx → read + rethrow the JSON error *before* SSE parsing (else a 502 body → silent empty stream → a failed run that looks successful); (b) a single streaming `TextDecoder({stream:true})` + concatenate before scanning `\n\n`.

**Files:**
- Modify: `apps/mesh/src/harnesses/remote-dispatch.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts:866-887` (pass `proxyDaemonRequest` instead of `getDispatch()`)
- Reference: `apps/mesh/src/sandbox/resolve-provider.ts` (`buildDesktopProvider(ctx, userId)` → a `SandboxProvider`), `packages/sandbox/server/provider/desktop/runner.ts:181` (`proxyDaemonRequest`).
- Test: `apps/mesh/src/harnesses/remote-dispatch.test.ts`

- [ ] **Step 1: Write the failing test.** Replace the dep with a `proxyDaemonRequest`-shaped fn and add the silent-error guard:

```ts
import { describe, it, expect } from "bun:test";
import { remoteDispatch } from "./remote-dispatch";

function resFromSse(events: string[]): Response {
  const body = events.map((e) => `data: ${e}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("remoteDispatch over proxyDaemonRequest", () => {
  it("yields ui-message-chunks from the SSE Response", async () => {
    const proxy = async () => resFromSse([JSON.stringify({ type: "ui-message-chunk", chunk: { t: 1 } }), JSON.stringify({ type: "done" })]);
    const out: unknown[] = [];
    for await (const c of remoteDispatch("claude-code", { runId: "r", messages: [] } as never, "u", "h", { proxyDaemonRequest: proxy } as never)) out.push(c);
    expect(out).toEqual([{ t: 1 }]);
  });
  it("throws on a non-2xx Response BEFORE SSE parsing (no silent empty stream)", async () => {
    const proxy = async () => new Response(JSON.stringify({ error: "boom" }), { status: 502, headers: { "content-type": "application/json" } });
    await expect((async () => { for await (const _ of remoteDispatch("codex", { runId: "r" } as never, "u", "h", { proxyDaemonRequest: proxy } as never)) { /* */ } })())
      .rejects.toThrow(/boom/);
  });
  it("reassembles a multi-byte UTF-8 SSE event split across two Response chunks", async () => {
    const enc = new TextEncoder();
    const full = `data: ${JSON.stringify({ type: "ui-message-chunk", chunk: { t: "héllo😀" } })}\n\n`;
    const bytes = enc.encode(full);
    const cut = 12; // mid multi-byte
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); } });
    const proxy = async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const out: unknown[] = [];
    for await (const c of remoteDispatch("claude-code", { runId: "r" } as never, "u", "h", { proxyDaemonRequest: proxy } as never)) out.push(c);
    expect(out).toEqual([{ t: "héllo😀" }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test apps/mesh/src/harnesses/remote-dispatch.test.ts`
Expected: FAIL (deps shape + Response consumption not implemented).

- [ ] **Step 3: Implement.** Change `RemoteDispatchDeps` to `{ proxyDaemonRequest: (handle: string, path: string, init: { method: string; headers: Record<string,string>; body?: string; signal?: AbortSignal }) => Promise<Response> }`. Rewrite the iterator:

```ts
const res = await deps.proxyDaemonRequest(sandboxHandle, "/dispatch", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "text/event-stream" },
  body,
  signal,
});
if (!res.ok) {
  let detail = `dispatch failed (${res.status})`;
  try { const j = await res.json(); if (j?.error) detail = String(j.error); } catch { /* */ }
  throw new Error(`[remoteDispatch] ${detail}`);
}
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true }); // SINGLE streaming decoder
  let sep = buffer.indexOf("\n\n");
  while (sep !== -1) {
    const block = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    for (const chunk of emitEvent(block)) yield chunk; // emitEvent unchanged
    sep = buffer.indexOf("\n\n");
  }
}
buffer += decoder.decode();
const tail = buffer.trim();
if (tail.length > 0) for (const chunk of emitEvent(tail)) yield chunk;
```

Keep `emitEvent` (parses `data:` lines, throws on `{type:error}`). In `dispatch-run.ts`, build the desktop provider and pass it:

```ts
const provider = await buildDesktopProvider(ctx, input.userId);
harnessChunks = remoteDispatch(harnessId, harnessInput, input.userId, sandboxHandle, {
  proxyDaemonRequest: (h, p, init) => provider.proxyDaemonRequest(h, p, init),
});
```

(Import `buildDesktopProvider` from `@/sandbox/lifecycle` or via `resolveProvider`.)

- [ ] **Step 4: Run to verify it passes.**

Run: `bun test apps/mesh/src/harnesses/remote-dispatch.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/mesh/src/harnesses/remote-dispatch.ts apps/mesh/src/harnesses/remote-dispatch.test.ts apps/mesh/src/api/routes/decopilot/dispatch-run.ts
git commit -m "feat(harnesses): route remoteDispatch through proxyDaemonRequest (unify seam)"
```

---

## Task 8: Offload encode + capability gate + cleanup (Part B encode)

**Why:** Before sending, if the body is oversized, offload `messages` to object storage (when the daemon advertises `body-offload` and real storage exists); else throw. Best-effort delete only on clean completion; the bucket TTL is the real reclaimer.

**Files:**
- Modify: `apps/mesh/src/harnesses/remote-dispatch.ts` (encode + cleanup)
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` (build the offload closure from `ctx.objectStorage` + read daemon capabilities from the link claim)
- Reference: Task 4 (`offloadKey`, `shouldOffload`, `sha256Hex`, `MessagesRef`), `apps/mesh/src/links/link-claim-registry.ts` (capabilities), `apps/mesh/src/object-storage/bound-object-storage.ts`.
- Test: `apps/mesh/src/harnesses/remote-dispatch.test.ts`

- [ ] **Step 1: Write the failing test (pure-ish, injected offload fn).**

```ts
it("offloads messages and emits a messagesRef envelope when oversized", async () => {
  const captured: { body?: string } = {};
  const proxy = async (_h: string, _p: string, init: { body?: string }) => {
    captured.body = init.body;
    return resFromSse([JSON.stringify({ type: "done" })]);
  };
  const big = "x".repeat(900 * 1024);
  const offload = async () => ({ url: "https://s/r", bytes: 1, sha256: "ab" });
  const deps = { proxyDaemonRequest: proxy, offload: { supported: true, put: offload, cleanup: async () => {} } };
  for await (const _ of remoteDispatch("claude-code", { runId: "r", messages: [{ role: "user", content: big }] } as never, "u", "h", deps as never)) { /* */ }
  const env = JSON.parse(captured.body!);
  expect(env.messagesRef).toEqual({ url: "https://s/r", bytes: 1, sha256: "ab" });
  expect(env.input.messages).toEqual([]); // offloaded out of band
});

it("throws when oversized but the daemon lacks body-offload", async () => {
  const proxy = async () => resFromSse([]);
  const big = "x".repeat(900 * 1024);
  const deps = { proxyDaemonRequest: proxy, offload: { supported: false } };
  await expect((async () => { for await (const _ of remoteDispatch("claude-code", { runId: "r", messages: [{ role: "user", content: big }] } as never, "u", "h", deps as never)) { /* */ } })())
    .rejects.toThrow(/too old|too large/i);
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test apps/mesh/src/harnesses/remote-dispatch.test.ts -t offload`
Expected: FAIL.

- [ ] **Step 3: Implement encode in `remote-dispatch.ts`.** Extend deps with an optional `offload`:

```ts
offload?: {
  supported: boolean; // daemon advertises body-offload
  put: (reqId: string, messagesJson: string) => Promise<MessagesRef>;
  cleanup: (key: string) => Promise<void>;
};
```

In the iterator, after building `wireInput`:

```ts
const messagesJson = JSON.stringify(wireInput.messages);
const baseBody = JSON.stringify({ harnessId: id, input: wireInput });
let body = baseBody;
let cleanupKey: string | null = null;
if (shouldOffload(new TextEncoder().encode(baseBody).byteLength)) {
  if (!deps.offload?.supported || !deps.offload) {
    throw new Error("request too large and remote sandbox cannot receive offloaded payloads (daemon too old or no object storage)");
  }
  const reqId = crypto.randomUUID();
  const ref = await deps.offload.put(reqId, messagesJson); // PUT + presign(requireFetchable)
  cleanupKey = offloadKey(reqId);
  body = JSON.stringify({ harnessId: id, input: { ...wireInput, messages: [] }, messagesRef: ref });
}
```

Wrap the stream loop so the eager delete fires **only on clean completion**, never on abort/throw:

```ts
let completed = false;
try {
  // ... consume Response, yield chunks ...
  completed = true;
} finally {
  if (completed && cleanupKey && deps.offload) {
    deps.offload.cleanup(cleanupKey).catch(() => { /* TTL reclaims */ });
  }
}
```

In `dispatch-run.ts`, build the offload closure + capability flag:

```ts
const claim = await linkClaimRegistry.get(input.userId); // capabilities[]
const supported = claim?.capabilities?.includes("body-offload") ?? false;
const offload = ctx.objectStorage ? {
  supported,
  put: async (reqId: string, messagesJson: string) => {
    const bytes = new TextEncoder().encode(messagesJson);
    const key = offloadKey(reqId);
    await ctx.objectStorage!.put(key, bytes, { contentType: "application/json" });
    const url = await ctx.objectStorage!.presignedGetUrl(key, 600, { requireFetchable: true });
    return { url, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) };
  },
  cleanup: (key: string) => ctx.objectStorage!.delete(key).then(() => {}),
} : { supported: false, put: async () => { throw new Error("no object storage"); }, cleanup: async () => {} };
```

Pass `offload` in the `remoteDispatch` deps.

- [ ] **Step 4: Run to verify it passes.**

Run: `bun test apps/mesh/src/harnesses/remote-dispatch.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/mesh/src/harnesses/remote-dispatch.ts apps/mesh/src/harnesses/remote-dispatch.test.ts apps/mesh/src/api/routes/decopilot/dispatch-run.ts
git commit -m "feat(harnesses): offload oversized messages by reference (capability-gated)"
```

---

## Task 9: Auto-provision MinIO in dev

**Why:** Object storage is now a hard dependency; `bun run dev` must bring up real S3-compatible storage so the offload path works and is testable locally.

**Files:**
- Modify: `apps/mesh/src/services/ensure-services.ts` (add `ensureMinio(home)` mirroring `ensureNats`: download/spawn the MinIO binary, create the bucket, set the lifecycle rule on `*/link-dispatch/`)
- Modify: `apps/mesh/src/core/context-factory.ts:1188` (when MinIO is up, resolve `objectStorage` to the real `S3Service` pointed at it)
- Reference: `ensure-services.ts:521-660` (the `nats-server` download/spawn/ownership pattern), `.github/workflows/e2e.yml:93-140` (MinIO env + bucket creation already used by e2e — reuse the same `S3_*` env contract).

- [ ] **Step 1: Write the failing test (pure: artifact/URL builders).** Mirror the NATS artifact-name test pattern. Add a pure `minioArtifactName(os, arch)` + `minioDownloadUrl(...)` and unit-test them (no network).

```ts
import { describe, it, expect } from "bun:test";
import { minioArtifactName } from "./ensure-services";
describe("minioArtifactName", () => {
  it("builds the darwin-arm64 artifact path", () => {
    expect(minioArtifactName("darwin", "arm64")).toContain("darwin-arm64");
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test apps/mesh/src/services/ensure-services.test.ts -t minioArtifactName`
Expected: FAIL.

- [ ] **Step 3: Implement `ensureMinio`** following `ensureNats`: resolve the platform artifact, download to `servicesDir(home)/minio/bin/minio` if absent, spawn it with `S3_*` env on a known port, wait for `/minio/health/ready`, create the bucket (reuse the e2e bucket-create snippet), and apply a lifecycle rule expiring `link-dispatch/` objects after 1 day. Export `minioArtifactName`/`minioDownloadUrl` as pure helpers. Set the resolved `S3_ENDPOINT`/`S3_BUCKET`/credentials so `context-factory.ts` resolves `objectStorage` to a real `S3Service`. Call `ensureMinio` from the dev bootstrap alongside `ensurePostgres`/`ensureNats`.

- [ ] **Step 4: Run to verify the pure tests pass + manual smoke.**

Run: `bun test apps/mesh/src/services/ensure-services.test.ts && bun run check`
Then manual: `bun run dev` → confirm MinIO comes up, bucket exists, no `DevObjectStorage` in logs for org contexts.
Expected: PASS + MinIO healthy.

- [ ] **Step 5: Commit.**

```bash
git add apps/mesh/src/services/ensure-services.ts apps/mesh/src/services/ensure-services.test.ts apps/mesh/src/core/context-factory.ts
git commit -m "feat(dev): auto-provision MinIO as a managed dev dependency"
```

---

## Task 10: Shared terminal error-code enum

**Why:** The safe slice of the cancel/error normalization — one enum of terminal error codes each transport maps into. NOT a unified cancel model.

**Files:**
- Create: `apps/mesh/src/links/protocol/error-codes.ts`
- Modify: producers of `{type:"error", code}` to use the enum (`ws-gateway.ts` `publish_failed`/`ws_closed`, `dispatch.ts` `harness_crashed`/`bad_input`/`unknown_harness`/`offload_fetch_failed`, `remote-dispatch.ts`).
- Test: `apps/mesh/src/links/protocol/error-codes.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect } from "bun:test";
import { LINK_ERROR_CODES } from "./error-codes";
describe("LINK_ERROR_CODES", () => {
  it("contains the known terminal codes", () => {
    expect(LINK_ERROR_CODES).toContain("ws_closed");
    expect(LINK_ERROR_CODES).toContain("offload_fetch_failed");
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test apps/mesh/src/links/protocol/error-codes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

```ts
export const LINK_ERROR_CODES = [
  "publish_failed", "ws_closed", "harness_crashed",
  "bad_input", "unknown_harness", "tombstoned", "offload_fetch_failed",
] as const;
export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];
```

Replace the string literals in the producers with `LinkErrorCode` values (no behavior change — same strings).

- [ ] **Step 4: Run to verify it passes.**

Run: `bun test apps/mesh/src/links/protocol/error-codes.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/mesh/src/links/protocol/error-codes.ts apps/mesh/src/links/protocol/error-codes.test.ts apps/mesh/src/links/ws-gateway.ts packages/sandbox/daemon/routes/dispatch.ts apps/mesh/src/harnesses/remote-dispatch.ts
git commit -m "refactor(links): shared terminal error-code enum"
```

---

## Task 11: Remove dead `exec` from the provider seam

**Why:** `SandboxProvider.exec()` has zero production callers; folding it into `proxyDaemonRequest` would silently change its error contract. Remove it instead (only if knip confirms no callers).

**Files:**
- Modify: `packages/sandbox/server/provider/types.ts` (`exec`, `ExecInput`, `ExecOutput`)
- Modify: `packages/sandbox/server/provider/agent-sandbox/runner.ts` + `packages/sandbox/server/provider/desktop/runner.ts` (their `exec` impls)

- [ ] **Step 1: Confirm no callers.**

Run: `bun run lint` (knip) and `rg "\.exec\(" apps/mesh packages/sandbox`
Expected: only the two provider definitions + regex false-positives; no production caller.

- [ ] **Step 2: Remove** `exec`/`ExecInput`/`ExecOutput` from `types.ts` and both runner impls. If a caller *does* exist, SKIP this task and leave `exec` untouched (do not fold).

- [ ] **Step 3: Type-check + knip.**

Run: `bun run check && bun run lint`
Expected: PASS, no new knip warnings.

- [ ] **Step 4: Commit.**

```bash
git add packages/sandbox/server/provider/types.ts packages/sandbox/server/provider/agent-sandbox/runner.ts packages/sandbox/server/provider/desktop/runner.ts
git commit -m "refactor(sandbox): remove unused SandboxProvider.exec"
```

---

## Task 12: E2E coverage

**Files:**
- Create: `apps/mesh/e2e/tests/link-dispatch-offload.spec.ts`
- Reference: existing `apps/mesh/e2e/tests/link-dispatch-happy.spec.ts` for the link-daemon test harness setup; e2e runs against real MinIO (`S3_*` env).

- [ ] **Step 1: Write the e2e cases (all should initially fail or be skipped until the daemon side is wired):**
  1. **Oversized dispatch round-trips:** send a dispatch whose `messages[]` exceeds 768 KiB over a user-desktop link → run completes, output intact, an object appeared under `link-dispatch/` and was deleted on completion.
  2. **Pre-body dispatch error → failed run:** force a non-2xx from `/dispatch` → the run fails with a persisted error message (guards the silent-empty-stream regression).
  3. **UTF-8 SSE split:** covered by the unit test in Task 7; add an e2e asserting a large multibyte response streams intact.
  4. **No `body-offload` capability + oversized body → clean error** (no empty body sent).
  5. **SSRF:** a `messagesRef.url` off the daemon allowlist → `offload_fetch_failed`, run fails cleanly.
  6. **No real storage + oversized body → clean error.**

- [ ] **Step 2: Run.**

Run: `cd apps/mesh && bun run e2e link-dispatch-offload` (or the repo's e2e command)
Expected: PASS against real Postgres+NATS+MinIO.

- [ ] **Step 3: Commit.**

```bash
git add apps/mesh/e2e/tests/link-dispatch-offload.spec.ts
git commit -m "test(e2e): link dispatch message offload-by-reference"
```

---

## Self-review checklist (run before handoff)

- **Spec coverage:** Part A (Task 7) ✓; Part B encode (Tasks 4, 8) ✓; Part B decode (Tasks 5, 6) ✓; capability gate (Task 2) ✓; hard dependency + MinIO (Task 9) ✓; `requireFetchable`/vision split (Task 3) ✓; cleanup/TTL (Task 8 cleanup + Task 9 lifecycle rule) ✓; SSRF/security (Task 5) ✓; reduced C cleanups (Tasks 1, 10, 11) ✓; failure modes (Task 12 e2e) ✓.
- **No placeholders:** every code step has real code.
- **Type consistency:** `MessagesRef`, `DispatchEnvelope`, `parseMessagesRef`, `offloadKey`, `shouldOffload`, `sha256Hex`, `assertFetchableUrl`, `assertAllowedRefUrl`, `fetchOffloadedMessages`, `LINK_ERROR_CODES` are defined once and reused consistently.

## Known gaps to confirm during execution
- The daemon's `allowedHosts`/`allowSameHostDev` source (Task 6) must be threaded from daemon boot config; confirm where the daemon learns the mesh storage public host (hello/config payload).
- `linkClaimRegistry.get(userId)` capability read in Task 8 — confirm the exact accessor + that capabilities are populated at dispatch time.
- MinIO binary auto-provision (Task 9) cross-platform parity with the `nats-server` pattern needs validation on first run.
