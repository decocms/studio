# Local-Link Pull Inversion — Phase A (SoR Ingest Endpoint) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cluster HTTP endpoint that receives a harness's `UIMessageChunk` stream over the wire and drives the existing v2 `PartEmitter` + JetStream live-edge pump — the **return path** the desktop will push into once it runs the harness itself.

**Architecture:** Today `dispatch-run.ts` both *runs* the harness (inside `createUIMessageStream`'s `execute`) and *consumes* it (`onStepFinish`/`onFinish`/`onError` → `PartEmitter` + `streamBuffer.pump`). This phase extracts only the **consume half** into a reusable function and exposes it behind `POST /api/:org/links/runs/:runId/stream`. A fence-token check (plain Postgres CAS) makes a stale producer's writes `409`. Nothing existing changes behavior — this is a new, additive endpoint plus one behavior-preserving refactor.

**Tech Stack:** Bun, TypeScript, Hono, Kysely (Postgres), NATS JetStream, the AI SDK (`createUIMessageStream`, `UIMessageChunk`), `bun test` (unit), Playwright (e2e).

**Spec:** [`local-link-pull-inversion-spec.md`](local-link-pull-inversion-spec.md) §3.3, §3.5 (Phase A row in §7). Companion: [`stream-of-record-spec.md`](stream-of-record-spec.md).

**Testing conventions (from `TESTING.md`):** two tiers only. **Unit (`bun test`, co-located `*.test.ts`)** = pure logic, no DB/NATS/HTTP/mocks. **E2E (Playwright, `apps/mesh/e2e/tests/`)** = anything touching Postgres/NATS/HTTP. This plan puts the SSE parser, the fence predicate, and the stream-assembly logic in unit tests; the migration, the storage read, and the live endpoint in e2e.

**Execution note:** Implement on an isolated worktree/branch (see `superpowers:using-git-worktrees`). Run `bun run fmt` before every commit (lefthook enforces it).

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `apps/mesh/src/harnesses/parse-dispatch-sse.ts` | Pure: turn an SSE `ReadableStream` (the `/dispatch` wire format) into `AsyncIterable<UIMessageChunk>`; throw on `error` events. | **New** |
| `apps/mesh/src/harnesses/parse-dispatch-sse.test.ts` | Unit tests for the parser. | **New** |
| `apps/mesh/src/harnesses/remote-dispatch.ts` | Refactor to reuse the shared parser (behavior-preserving). | Modify |
| `apps/mesh/migrations/099-run-fence.ts` | Add `threads.run_fence_token` (nullable). | **New** |
| `apps/mesh/src/storage/types.ts` | Add `run_fence_token` to the `threads` table type. | Modify |
| `apps/mesh/src/storage/run-fence.ts` | Pure `fenceMatches(current, presented)` predicate. | **New** |
| `apps/mesh/src/storage/run-fence.test.ts` | Unit tests for `fenceMatches`. | **New** |
| `apps/mesh/src/storage/threads.ts` | Add `getRunFence` / `setRunFence` storage methods. | Modify |
| `apps/mesh/src/api/routes/decopilot/consume-part-stream.ts` | Assemble a chunk stream into messages and drive an emitter (`emitStepParts`/`emitFinal`/`emitError`); return the `uiStream`. | **New** |
| `apps/mesh/src/api/routes/decopilot/consume-part-stream.test.ts` | Unit tests with an in-memory collector emitter. | **New** |
| `apps/mesh/src/api/routes/decopilot/link-ingest-routes.ts` | `POST /links/runs/:runId/stream`: fence check → parse → consume → pump. | **New** |
| `apps/mesh/src/api/routes/org-scoped.ts` | Mount the ingest router. | Modify |
| `apps/mesh/e2e/tests/link-ingest.spec.ts` | E2E: parts land for a valid fence; `409` for a stale one. | **New** |

---

## Task 1: Shared SSE → UIMessageChunk parser

Extract the SSE-block parsing currently inlined in `remoteDispatch` (the `emitEvent` generator + the `\n\n`-delimited buffer loop, `remote-dispatch.ts:56-81` and `:140-165`) into a reusable parser. The ingest endpoint consumes the **same** `/dispatch` SSE format the daemon emits, so this is shared verbatim.

**Files:**
- Create: `apps/mesh/src/harnesses/parse-dispatch-sse.ts`
- Test: `apps/mesh/src/harnesses/parse-dispatch-sse.test.ts`
- Modify: `apps/mesh/src/harnesses/remote-dispatch.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/harnesses/parse-dispatch-sse.test.ts
import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import { parseDispatchSSEStream } from "./parse-dispatch-sse";

function sseStream(blocks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const b of blocks) controller.enqueue(enc.encode(b));
      controller.close();
    },
  });
}

async function collect(it: AsyncIterable<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("parseDispatchSSEStream", () => {
  it("yields ui-message-chunk payloads, ignores done", async () => {
    const body = sseStream([
      'data: {"type":"ui-message-chunk","chunk":{"type":"text-delta","id":"m1","delta":"hi"}}\n\n',
      'data: {"type":"done"}\n\n',
    ]);
    const chunks = await collect(parseDispatchSSEStream(body));
    expect(chunks).toEqual([{ type: "text-delta", id: "m1", delta: "hi" }]);
  });

  it("reassembles an event split across read boundaries", async () => {
    const body = sseStream([
      'data: {"type":"ui-message-chunk","chunk":{"type":"text-',
      'delta","id":"m1","delta":"hi"}}\n\n',
    ]);
    const chunks = await collect(parseDispatchSSEStream(body));
    expect(chunks).toEqual([{ type: "text-delta", id: "m1", delta: "hi" }]);
  });

  it("throws on an error event", async () => {
    const body = sseStream([
      'data: {"type":"error","code":"harness_crashed","message":"boom"}\n\n',
    ]);
    await expect(collect(parseDispatchSSEStream(body))).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/harnesses/parse-dispatch-sse.test.ts`
Expected: FAIL — `Cannot find module './parse-dispatch-sse'`.

- [ ] **Step 3: Write the parser**

```ts
// apps/mesh/src/harnesses/parse-dispatch-sse.ts
/**
 * Parse a `/dispatch` SSE response body into a stream of UIMessageChunk.
 *
 * The wire format (emitted by the sandbox daemon's `/dispatch` route) is a
 * sequence of `\n\n`-delimited event blocks, each with one or more `data: `
 * lines whose joined JSON matches `dispatchSSEEventSchema`. Shared by
 * `remoteDispatch` (cluster pulls the daemon) and the link ingest endpoint
 * (desktop pushes the cluster) so both decode identically.
 */
import type { UIMessageChunk } from "ai";
import { dispatchSSEEventSchema } from "../links/protocol";

function* emitEvent(eventText: string): Generator<UIMessageChunk> {
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
    throw new Error(`[parseDispatchSSE] ${ev.data.code}: ${ev.data.message}`);
  }
  // `done` yields no chunk — the iterable ends when the body closes.
}

export async function* parseDispatchSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<UIMessageChunk> {
  const reader = body.getReader();
  // SINGLE streaming decoder — a multi-byte UTF-8 char can split across reads.
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        yield* emitEvent(block);
        sep = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > 0) yield* emitEvent(tail);
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/harnesses/parse-dispatch-sse.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Refactor `remoteDispatch` to use the shared parser**

In `apps/mesh/src/harnesses/remote-dispatch.ts`, delete the local `emitEvent` generator (lines ~56-81) and the manual buffer loop (lines ~140-165), and replace the body-reading section with the shared parser. The new `remote-dispatch.ts` reading section becomes:

```ts
        const responseBody = res.body;
        if (!responseBody)
          throw new Error("[remoteDispatch] response body is null");
        for await (const chunk of parseDispatchSSEStream(responseBody)) {
          yield chunk;
        }
        completed = true;
```

Add the import at the top of `remote-dispatch.ts`:

```ts
import { parseDispatchSSEStream } from "./parse-dispatch-sse";
```

Remove the now-unused `dispatchSSEEventSchema` import from `remote-dispatch.ts` (it moved into the parser).

- [ ] **Step 6: Run the existing remote-dispatch coverage + typecheck**

Run: `bun run --cwd=apps/mesh check && bun test apps/mesh/src/harnesses/`
Expected: PASS, no type errors. (If a `remote-dispatch.test.ts` exists, it must still pass — behavior is unchanged.)

- [ ] **Step 7: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/harnesses/parse-dispatch-sse.ts apps/mesh/src/harnesses/parse-dispatch-sse.test.ts apps/mesh/src/harnesses/remote-dispatch.ts
git commit -m "refactor(harnesses): extract shared parseDispatchSSEStream for reuse by the link ingest"
```

---

## Task 2: Run-fence column, type, predicate, and storage

The fence token is the single-writer guarantee at the write layer (spec §3.5). Phase A adds the column, a pure match predicate, and read/write storage methods; the token is *minted* in Phase B (`prepareRun`). With no token set, the predicate accepts (Phase A is additive).

**Files:**
- Create: `apps/mesh/migrations/099-run-fence.ts` (use the next free number — confirm `ls apps/mesh/migrations/ | sort | tail -1`; `098-thread-message-parts.ts` is the SoR table, so `099` is expected)
- Modify: `apps/mesh/src/storage/types.ts`
- Create: `apps/mesh/src/storage/run-fence.ts`, `apps/mesh/src/storage/run-fence.test.ts`
- Modify: `apps/mesh/src/storage/threads.ts`

- [ ] **Step 1: Write the failing predicate test**

```ts
// apps/mesh/src/storage/run-fence.test.ts
import { describe, expect, it } from "bun:test";
import { fenceMatches } from "./run-fence";

describe("fenceMatches", () => {
  it("accepts when no fence is set (null current)", () => {
    expect(fenceMatches(null, "tok-1")).toBe(true);
    expect(fenceMatches(null, null)).toBe(true);
  });
  it("accepts an exact match", () => {
    expect(fenceMatches("tok-1", "tok-1")).toBe(true);
  });
  it("rejects a stale/absent presented token when a fence is set", () => {
    expect(fenceMatches("tok-2", "tok-1")).toBe(false);
    expect(fenceMatches("tok-2", null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/storage/run-fence.test.ts`
Expected: FAIL — `Cannot find module './run-fence'`.

- [ ] **Step 3: Write the predicate**

```ts
// apps/mesh/src/storage/run-fence.ts
/**
 * Single-writer fence (spec §3.5). The current fence token for a run lives on
 * `threads.run_fence_token`. An append from the desktop is accepted only when
 * the presented token is current. A null current means no fence has been minted
 * yet (Phase A: minting lands in Phase B), so writes are accepted.
 */
export function fenceMatches(
  current: string | null,
  presented: string | null,
): boolean {
  if (current === null) return true;
  return current === presented;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/storage/run-fence.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the migration**

```ts
// apps/mesh/migrations/099-run-fence.ts
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("run_fence_token", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("run_fence_token").execute();
}
```

- [ ] **Step 6: Add the column to the `threads` table type**

In `apps/mesh/src/storage/types.ts`, in the `threads` table interface (near `message_storage_version`, ~line 871), add:

```ts
  /** Single-writer fence for the active run; null when none minted (spec §3.5). */
  run_fence_token: ColumnType<string | null, string | null, string | null>;
```

- [ ] **Step 7: Add storage read/write methods**

In `apps/mesh/src/storage/threads.ts`, add two methods to the threads storage class (alongside the existing `claimRunStart`/`bumpProgress` methods — match the surrounding style):

```ts
  /** Current fence token for a run (thread id == run id today). */
  async getRunFence(threadId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("threads")
      .select("run_fence_token")
      .where("id", "=", threadId)
      .executeTakeFirst();
    return row?.run_fence_token ?? null;
  }

  /** Set (or clear) the fence token. Phase B mints it in prepareRun. */
  async setRunFence(threadId: string, token: string | null): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({ run_fence_token: token })
      .where("id", "=", threadId)
      .execute();
  }
```

- [ ] **Step 8: Typecheck and run the migration locally**

Run: `bun run --cwd=apps/mesh check && bun run --cwd=apps/mesh migrate`
Expected: type-check passes; migration `099-run-fence` applies cleanly.

- [ ] **Step 9: Format and commit**

```bash
bun run fmt
git add apps/mesh/migrations/099-run-fence.ts apps/mesh/src/storage/types.ts apps/mesh/src/storage/run-fence.ts apps/mesh/src/storage/run-fence.test.ts apps/mesh/src/storage/threads.ts
git commit -m "feat(storage): add run_fence_token column, fenceMatches predicate, and accessors"
```

---

## Task 3: `consumePartStream` — assemble chunks and drive an emitter

This is the consume half lifted out of `dispatch-run.ts` (the `createUIMessageStream` at L880 with its `onStepFinish`/`onFinish`/`onError` → `PartEmitter`), but *without* the harness `execute` (the harness now runs on the desktop) and *without* the decopilot in-process extras (`processLocal`, html-page buffer, title interception — those also move to the desktop). It takes a chunk stream, assembles it via the AI SDK, and calls an emitter. It returns the assembled `uiStream` so the caller can pump it to the live edge.

The emitter is an **interface** (which `PartEmitter` already satisfies) so this module is unit-testable with a plain in-memory collector — no DB.

**Files:**
- Create: `apps/mesh/src/api/routes/decopilot/consume-part-stream.ts`
- Test: `apps/mesh/src/api/routes/decopilot/consume-part-stream.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/api/routes/decopilot/consume-part-stream.test.ts
import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import { consumePartStream, type PartEmitterLike } from "./consume-part-stream";

function chunkStream(chunks: UIMessageChunk[]): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

class CollectorEmitter implements PartEmitterLike {
  steps: { id: string; text: string }[] = [];
  finals: { id: string; text: string }[] = [];
  errors: string[] = [];
  private textOf(m: { id: string; parts?: unknown[] }) {
    const t = (m.parts ?? []).find(
      (p): p is { type: string; text: string } =>
        typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
    );
    return { id: m.id, text: t?.text ?? "" };
  }
  async emitStepParts(m: { id: string; parts?: unknown[] }) {
    this.steps.push(this.textOf(m));
  }
  async emitFinal(m: { id: string; parts?: unknown[] }) {
    this.finals.push(this.textOf(m));
  }
  async emitError(_messageId: string, errorText: string) {
    this.errors.push(errorText);
  }
}

async function drain(s: ReadableStream): Promise<void> {
  const r = s.getReader();
  try {
    while (true) {
      const { done } = await r.read();
      if (done) break;
    }
  } finally {
    r.releaseLock();
  }
}

describe("consumePartStream", () => {
  it("assembles a text message and calls emitFinal", async () => {
    const emitter = new CollectorEmitter();
    const chunks = chunkStream([
      { type: "start" } as UIMessageChunk,
      { type: "text-start", id: "t1" } as UIMessageChunk,
      { type: "text-delta", id: "t1", delta: "hello " } as UIMessageChunk,
      { type: "text-delta", id: "t1", delta: "world" } as UIMessageChunk,
      { type: "text-end", id: "t1" } as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ]);
    const ui = consumePartStream(chunks, emitter);
    await drain(ui);
    expect(emitter.finals.map((f) => f.text)).toEqual(["hello world"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/api/routes/decopilot/consume-part-stream.test.ts`
Expected: FAIL — `Cannot find module './consume-part-stream'`.

- [ ] **Step 3: Write the consume pipeline**

```ts
// apps/mesh/src/api/routes/decopilot/consume-part-stream.ts
/**
 * Cluster-side CONSUME half of a run, fed by a chunk stream that was produced
 * elsewhere (the desktop daemon, pushed over the link ingest). Mirrors the
 * `createUIMessageStream` + onStepFinish/onFinish/onError wiring in
 * `dispatch-run.ts`, minus the harness `execute` (the harness ran on the
 * desktop) and the decopilot in-process extras. Assembles chunks into messages
 * and drives the emitter; returns the assembled `uiStream` for the caller to
 * pump into the JetStream live edge.
 */
import { type UIMessageChunk, createUIMessageStream } from "ai";

/**
 * The slice of `PartEmitter` this consumer needs (so it stays unit-testable).
 * Method params mirror `PartEmitter`'s `AnyMessage` exactly (`role` included) so
 * the real `PartEmitter` structurally satisfies this interface and an AI-SDK
 * `responseMessage` is assignable.
 */
export interface PartEmitterLike {
  emitStepParts(message: {
    id: string;
    role: "user" | "assistant" | "system";
    parts?: unknown[];
  }): Promise<void>;
  emitFinal(message: {
    id: string;
    role: "user" | "assistant" | "system";
    parts?: unknown[];
  }): Promise<void>;
  emitError(messageId: string, errorText: string): Promise<void>;
}

function asReadableStream<T>(it: AsyncIterable<T>): ReadableStream<T> {
  const iter = it[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iter.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iter.return?.(undefined);
    },
  });
}

export interface ConsumePartStreamHooks {
  /** Called after each part-emit point (step/final) so the caller can advance
   *  liveness / run-registry state. Optional in Phase A. */
  onStep?: () => void;
  onFinish?: () => void;
  onError?: (error: unknown) => void;
}

export function consumePartStream(
  chunks: AsyncIterable<UIMessageChunk>,
  emitter: PartEmitterLike,
  hooks: ConsumePartStreamHooks = {},
): ReadableStream {
  const pending: Promise<void>[] = [];
  return createUIMessageStream({
    execute: ({ writer }) => {
      writer.merge(
        asReadableStream(chunks) as Parameters<typeof writer.merge>[0],
      );
    },
    onStepFinish: ({ responseMessage }) => {
      pending.push(
        emitter
          .emitStepParts(responseMessage)
          .catch((e) =>
            console.error("[link-ingest] emitStepParts failed", e),
          ),
      );
      hooks.onStep?.();
    },
    onFinish: async ({ responseMessage }) => {
      await Promise.allSettled(pending);
      await emitter
        .emitFinal(responseMessage)
        .catch((e) => console.error("[link-ingest] emitFinal failed", e));
      hooks.onFinish?.();
    },
    onError: (error) => {
      const text = error instanceof Error ? error.message : String(error);
      void emitter
        .emitError(crypto.randomUUID(), text)
        .catch((e) => console.error("[link-ingest] emitError failed", e));
      hooks.onError?.(error);
      return text;
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/api/routes/decopilot/consume-part-stream.test.ts`
Expected: PASS. (If the AI SDK names a chunk field differently than the test assumes, adjust the test's chunk shapes to match the SDK's `UIMessageChunk` union — the assembled `responseMessage.parts[0].text` must equal `"hello world"`.)

- [ ] **Step 5: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/consume-part-stream.ts apps/mesh/src/api/routes/decopilot/consume-part-stream.test.ts
git commit -m "feat(decopilot): add consumePartStream — assemble a chunk stream into parts via an emitter"
```

---

## Task 4: The ingest route `POST /links/runs/:runId/stream`

Wire the pieces: fence check → parse SSE body → `consumePartStream` with a real `PartEmitter` → tee the assembled stream (one branch pumps to the JetStream live edge, one branch drains so the request resolves when the run finishes).

**Files:**
- Create: `apps/mesh/src/api/routes/decopilot/link-ingest-routes.ts`
- Modify: `apps/mesh/src/api/routes/org-scoped.ts`
- Test: `apps/mesh/e2e/tests/link-ingest.spec.ts`

- [ ] **Step 1: Write the route**

```ts
// apps/mesh/src/api/routes/decopilot/link-ingest-routes.ts
/**
 * Link ingest — the RETURN path of the pull-inverted local link (spec §3.3).
 * The desktop daemon runs the harness and POSTs its UIMessageChunk SSE stream
 * here; this endpoint commits completed parts to `thread_message_parts` (via
 * PartEmitter) and republishes chunks to the JetStream live edge. The fence
 * token (§3.5) rejects a stale producer's writes with 409.
 */
import { Hono } from "hono";
import { parseDispatchSSEStream } from "@/harnesses/parse-dispatch-sse";
import { fenceMatches } from "@/storage/run-fence";
import { PartEmitter } from "./part-emitter";
import { consumePartStream } from "./consume-part-stream";
import type { StreamBuffer } from "./stream-buffer";
import type { Env } from "../hono-env";

export interface LinkIngestDeps {
  streamBuffer: StreamBuffer;
}

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createLinkIngestRoutes(deps: LinkIngestDeps) {
  const app = new Hono<Env>();

  // resolveOrgFromPath has already run (mounted under /api/:org). ctx is the
  // resolved StudioContext for the org member.
  app.post("/links/runs/:runId/stream", async (c) => {
    const ctx = c.get("studioContext");
    const runId = c.req.param("runId");
    const presented = c.req.header("x-fence-token") ?? null;

    const current = await ctx.storage.threads.getRunFence(runId);
    if (!fenceMatches(current, presented)) {
      return c.json({ error: "fenced" }, 409);
    }

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "missing body" }, 400);

    const partEmitter = new PartEmitter({
      storage: ctx.storage.threads.messageParts(),
      orgId: ctx.organization!.id,
      threadId: runId, // thread id == run id today
      runId,
    });

    const chunks = parseDispatchSSEStream(body);
    const { uiStream, whenComplete } = consumePartStream(chunks, partEmitter);

    // Tee: one branch feeds the live edge (the pump no-ops if NATS is down),
    // the other is drained so the stream is consumed regardless of the pump.
    // `whenComplete` is the authoritative "all parts committed" signal (driven
    // by the SDK onFinish, which awaits emitFinal/emitError) — we await it
    // rather than inferring completion from drain timing.
    const [toPump, toConsume] = uiStream.tee();
    deps.streamBuffer.pump(toPump, runId, c.req.raw.signal);
    await drain(toConsume);
    await whenComplete;

    return c.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 2: Mount the router in the org-scoped aggregator**

In `apps/mesh/src/api/routes/org-scoped.ts`:

Add to `OrgScopedDeps` (it already carries `streamBuffer`, so no new dep field is needed — reuse `deps.streamBuffer`). Add the import near the other route imports (line ~26):

```ts
import { createLinkIngestRoutes } from "./decopilot/link-ingest-routes";
```

And mount it alongside the other `app.route("/", ...)` calls (after line ~84):

```ts
  app.route("/", createLinkIngestRoutes({ streamBuffer: deps.streamBuffer })); // /api/:org/links/runs/:runId/stream
```

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. (If `c.get("studioContext")` is keyed differently in `Env`, match the existing accessor used by sibling routes in this folder — grep a neighboring route file for how it reads the resolved context and `ctx.organization`.)

- [ ] **Step 4: Write the e2e test**

```ts
// apps/mesh/e2e/tests/link-ingest.spec.ts
import { expect, test } from "@playwright/test";
import { createOrgAndUser, seedV2Thread, sseBody, listParts } from "../helpers";

// `sseBody(events)` joins `data: <json>\n\n` blocks; `seedV2Thread` inserts a
// thread with message_storage_version = 2; `listParts(threadId)` reads
// thread_message_parts. (Add these to e2e/helpers if absent — follow the
// patterns in decopilot-parts-readpath.spec.ts.)

test("ingest commits parts for a matching fence", async ({ request }) => {
  const { org, bearer } = await createOrgAndUser();
  const threadId = await seedV2Thread(org.id, { runFenceToken: "tok-1" });

  const res = await request.post(`/api/${org.slug}/links/runs/${threadId}/stream`, {
    headers: { Authorization: `Bearer ${bearer}`, "x-fence-token": "tok-1" },
    data: sseBody([
      { type: "ui-message-chunk", chunk: { type: "start" } },
      { type: "ui-message-chunk", chunk: { type: "text-start", id: "t1" } },
      { type: "ui-message-chunk", chunk: { type: "text-delta", id: "t1", delta: "hi" } },
      { type: "ui-message-chunk", chunk: { type: "text-end", id: "t1" } },
      { type: "ui-message-chunk", chunk: { type: "finish" } },
      { type: "done" },
    ]),
  });
  expect(res.status()).toBe(200);

  const parts = await listParts(threadId);
  expect(parts.some((p) => p.kind === "text")).toBe(true);
  expect(parts.some((p) => p.kind === "finish")).toBe(true);
});

test("ingest rejects a stale fence with 409", async ({ request }) => {
  const { org, bearer } = await createOrgAndUser();
  const threadId = await seedV2Thread(org.id, { runFenceToken: "tok-2" });

  const res = await request.post(`/api/${org.slug}/links/runs/${threadId}/stream`, {
    headers: { Authorization: `Bearer ${bearer}`, "x-fence-token": "tok-1" },
    data: sseBody([{ type: "done" }]),
  });
  expect(res.status()).toBe(409);
  expect(await listParts(threadId)).toHaveLength(0);
});
```

- [ ] **Step 5: Run the e2e test**

Run: `bun run --cwd=apps/mesh test:e2e link-ingest` (or the repo's Playwright invocation — see `apps/mesh/e2e/`).
Expected: both tests PASS — parts land for `tok-1`, `409` + zero parts for the stale token.

- [ ] **Step 6: Full check + lint + format, then commit**

```bash
bun run --cwd=apps/mesh check && bun run lint && bun run fmt:check
bun run fmt
git add apps/mesh/src/api/routes/decopilot/link-ingest-routes.ts apps/mesh/src/api/routes/org-scoped.ts apps/mesh/e2e/tests/link-ingest.spec.ts
git commit -m "feat(links): add POST /api/:org/links/runs/:runId/stream SoR ingest endpoint"
```

---

## Done criteria for Phase A

- `POST /api/:org/links/runs/:runId/stream` accepts a `/dispatch`-format SSE body, commits completed parts to `thread_message_parts`, republishes chunks to the JetStream live edge, and `409`s a stale fence.
- No existing behavior changed (`remoteDispatch` refactor is behavior-preserving; the new endpoint is unused by the gate until **Phase B** wires `prepareRun` to mint the fence + publish work).
- All unit tests (`parse-dispatch-sse`, `run-fence`, `consume-part-stream`) and the `link-ingest` e2e pass; `bun run check` and `bun run lint` are green.

**Next:** Phase B — JetStream WorkQueue + work long-poll + presence, and the DBOS gate change (publish + await durable completion), which mints the fence this endpoint checks. (Separate plan.)
