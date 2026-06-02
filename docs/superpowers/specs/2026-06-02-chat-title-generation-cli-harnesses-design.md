# Chat Title Generation for Claude Code and Codex Harnesses

**Date:** 2026-06-02
**Status:** Design approved; ready for implementation planning.

## Background

Studio's chat threads start with the title `"New chat"` (`DEFAULT_THREAD_TITLE`). Today, only the **Decopilot** harness auto-generates a better title from the user's first message. The two CLI-based harnesses — **Claude Code** and **Codex** — leave the thread named `"New chat"` indefinitely.

### Current Decopilot implementation

- `apps/mesh/src/harnesses/decopilot/title-generator.ts` exposes `genTitle({ abortSignal, model, userMessage })`, which:
  - Calls AI SDK's `generateObject` with `TITLE_GENERATOR_PROMPT` and a Zod schema `{ title: string }`.
  - Runs in parallel with the main LLM stream, with a 10s grace period after the parent stream finishes (`POST_STREAM_GRACE_MS`).
  - Falls back to `userMessage.split("\n")[0].slice(0, 60).trim()` on error/unusable output.
- `apps/mesh/src/harnesses/decopilot/run-stream.ts` (lines ~400–464) wires `genTitle` to:
  - `ctx.storage.threads.update(threadId, { title })` for persistence.
  - `onTitleUpdated(title)` (`buildOnTitleUpdated` in `apps/mesh/src/api/routes/decopilot/on-title-updated.ts`) for SSE fan-out to other tabs.
  - `chunkQueue.push({ type: "data-thread-title", data: { title }, transient: true })` for the live UI.
  - `processLocal.registerPendingOp(...)` so the outer drain waits for the title to settle.
- Gating: only runs when `currentThreadTitle === DEFAULT_THREAD_TITLE`.

### Architectural constraint

The Claude Code and Codex harnesses can run in two locations:

- **In-cluster (`localDispatch`)** — the harness runs in the mesh process. `processLocal` (containing `provider`, `onTitleUpdated`, `registerPendingOp`, etc.) is passed into the harness.
- **User-desktop daemon (`remoteDispatch`)** — the harness runs in the user's link daemon. `processLocal` is stripped before serialization; the daemon has no `ctx.storage`, no SSE hub, no pre-activated provider.

This means any solution that lives inside the harness only works for the in-cluster case. Title generation needs cluster-side state regardless of where the harness physically runs.

## Goal

A single title-generation pathway for all three harnesses (Decopilot, Claude Code, Codex), working uniformly across cluster-local and user-desktop dispatch. Harnesses become title-agnostic; the cluster's dispatch layer owns the model call, storage, SSE, and UI emission.

## Design decisions

| # | Question | Choice |
|---|----------|--------|
| Q1 | Where does title generation run? | **Server-side** — cluster generates titles for all three harnesses. |
| Q2 | What's the call site? | **Inside each harness** — each harness participates in the title flow. |
| Q3 | How do user-desktop runs get titled? | **Daemon emits a side-channel chunk** — works uniformly for local + remote dispatch. |
| Q4 | What about Decopilot's existing inline title block? | **Migrate to the same pattern** — single code path, single source of truth. |
| Q5a | When does the harness emit the chunk? | **Always on first turn** — policy lives in the dispatch layer. |
| Q5b | What does the chunk carry? | **Just `{ userMessage: string }`** — lean wire format. |
| Q5c | When in the stream does emission happen? | **Immediately**, before the main SDK call, for max parallelism. |
| — | What's the fallback when the LLM fails? | `userMessage.slice(0, 10).trim()` (literal characters, not words). |

## Architecture

### Wire format

A new transient `UIMessageChunk`:

```ts
{ type: "data-title-input", data: { userMessage: string }, transient: true }
```

- `transient: true` keeps it out of persisted message `parts`.
- Emitted by harnesses; consumed by the dispatch layer's interceptor.

### Components (5 units)

#### 1. Wire-format module (new)

`apps/mesh/src/harnesses/title-chunk.ts`

```ts
import type { UIMessageChunk } from "ai";

export const TITLE_INPUT_CHUNK_TYPE = "data-title-input" as const;

export function makeTitleInputChunk(userMessage: string): UIMessageChunk {
  return {
    type: TITLE_INPUT_CHUNK_TYPE,
    data: { userMessage },
    transient: true,
  };
}
```

Reason for a module: avoid string-literal drift across the 3 harnesses + the interceptor.

#### 2. Decopilot harness emission

`apps/mesh/src/harnesses/decopilot/run-stream.ts`

- Delete the title block (currently lines ~400–464): `genTitle` import, `shouldGenerateTitle` flag, `titleHandle` setup, the `.then(...)` block (storage update + `onTitleUpdated` + chunk push), and `registerPendingOp(titleOp)`.
- Add at the top of the stream, before the `streamText` call:
  ```ts
  const userMessageText = JSON.stringify(processedMessages[0]?.content ?? "");
  yield makeTitleInputChunk(userMessageText);
  ```
- Net change: ~60 lines deleted, ~3 added.

#### 3. Claude Code and Codex emission

`apps/mesh/src/harnesses/claude-code/index.ts` and `apps/mesh/src/harnesses/codex/index.ts`

In each harness, after `prepCliMessages` returns, extract the user message text:

```ts
const userMessageText = extractUserText(messages); // last user message
yield makeTitleInputChunk(userMessageText);
```

Then proceed with `streamText(...)` as today. `extractUserText` is a tiny helper colocated with `prepCliMessages` (or inlined) that walks the prepared `ModelMessage[]` and concatenates the most recent user message's text parts.

Net change: ~5 lines added per harness.

#### 4. Title interceptor (new)

`apps/mesh/src/api/routes/decopilot/title-interceptor.ts`

```ts
export interface TitleInterceptorDeps {
  ctx: MeshContext;
  processLocal: HarnessProcessLocal;          // provider, isStreamFinished, etc.
  models: ModelsConfig;
  currentThreadTitle: string;
  threadId: string;
  writer: UIMessageStreamWriter;
  registerPendingOp: (op: Promise<void>) => void;
  registrySignal: AbortSignal;
  onTitleUpdated?: (title: string) => Promise<void>;

  // Injectable for unit tests; default to the real imports.
  genTitle?: typeof realGenTitle;
  persistTitle?: (threadId: string, title: string) => Promise<void>;
}

export async function* interceptTitleChunks(
  source: AsyncIterable<UIMessageChunk>,
  deps: TitleInterceptorDeps,
): AsyncIterable<UIMessageChunk> { ... }
```

Behavior:

- Yields every non-`data-title-input` chunk unchanged (1-to-1 order).
- On first `data-title-input` chunk:
  - Set `triggered = true`; swallow the chunk (do NOT yield).
  - If `currentThreadTitle !== DEFAULT_THREAD_TITLE`, return early.
  - Spawn `genTitle({ abortSignal: registrySignal, model: createLanguageModel(processLocal.provider, models.fast ?? models.thinking), userMessage })`.
  - Register the resulting promise via `registerPendingOp`, with the body:
    ```
    title = await handle.promise
    if (title == null) return
    await persistTitle(threadId, title).catch(log)
    await onTitleUpdated?.(title).catch(log)
    if (!processLocal.isStreamFinished()) writer.write({ type: "data-thread-title", data: { title }, transient: true })
    ```
- On subsequent `data-title-input` chunks: swallow + `console.warn` ("harness emitted multiple title-input chunks"). Do NOT throw — contract violation is loggable, not fatal.
- The existing `genTitle.finish()` mechanism still applies; the interceptor must call `handle.finish()` when the upstream `source` iterator completes (use `try/finally` around the iteration).

Injectable deps (`genTitle`, `persistTitle`) keep the test suite at the unit tier — no `MeshContext` stubbing required.

#### 5. Dispatch wiring

`apps/mesh/src/api/routes/decopilot/dispatch-run.ts`

Around line ~886:

```diff
- let harnessChunks;
+ let rawHarnessChunks;
  if (target.runsIn === "user-desktop") {
-   harnessChunks = remoteDispatch(...);
+   rawHarnessChunks = remoteDispatch(...);
  } else {
-   harnessChunks = localDispatch(harnessId, harnessInput, ctx);
+   rawHarnessChunks = localDispatch(harnessId, harnessInput, ctx);
  }
+ const harnessChunks = interceptTitleChunks(rawHarnessChunks, {
+   ctx,
+   processLocal,
+   models: input.models,
+   currentThreadTitle: mem.thread.title,
+   threadId: mem.thread.id,
+   writer,
+   registerPendingOp: processLocal.registerPendingOp,
+   registrySignal,
+   onTitleUpdated: processLocal.onTitleUpdated,
+ });
  const harnessStream = asReadableStream(harnessChunks);
```

`buildOnTitleUpdated` and the `processLocal` object built earlier in this file stay where they are — the interceptor reads them out of the deps bag.

## Data flow

1. **Request arrives.** `dispatchRunAndWait` builds `harnessInput` with `currentThreadTitle: mem.thread.title`. Identical for all three harness ids.
2. **Harness starts.** The harness's `stream()` extracts user-message text in its native shape and yields exactly one `data-title-input` chunk. Then it kicks off its underlying SDK call (Decopilot's `streamText` with tools; Claude Code's `streamText` against the CLI provider; Codex's `streamText` against the Codex CLI provider).
3. **Interceptor sees the chunk.** The interceptor wraps the harness chunk stream in `dispatch-run.ts`. It:
   - Checks `triggered` flag (idempotency); checks `currentThreadTitle === DEFAULT_THREAD_TITLE` (policy).
   - On match: swallows the chunk, spawns `genTitle`, registers the promise as a pending op.
4. **Main stream continues in parallel.** All non-title chunks pass through unchanged to `writer.merge(...)`.
5. **Title resolves.** The pending-op body persists via `ctx.storage.threads.update`, fires `onTitleUpdated` (SSE), and writes a `data-thread-title` transient chunk if the stream is still open. Title failures are logged but never break the run.
6. **Stream finish.** Outer `createUIMessageStream.onFinish` does `await Promise.allSettled(pendingOps)`, which now includes the title op. The interceptor's `try/finally` calls `handle.finish()` on the title generator so its 10s grace period kicks in.

**Invariants preserved from today's Decopilot behavior:**
- Title gen runs in parallel with the main stream.
- Parent abort cancels title gen (`registrySignal` listener inside `genTitle`).
- Post-stream grace period stays at 10s.
- DB write → SSE → UI chunk ordering unchanged.

## Error handling & edge cases

### Title generation failures (handled in `genTitle`)
- Provider error / quota exceeded → falls back to `userMessage.slice(0, 10).trim()`.
- User message empty / all-punctuation after slicing → falls back to `"New chat"`.
- Parent aborts mid-generation → returns `null`; interceptor logs and skips persist.

### Interceptor-level failures
- `ctx.storage.threads.update` throws → log `[title-interceptor] persist failed`; do not crash. DB still shows `"New chat"`, so the next turn will retry titling.
- `onTitleUpdated` throws → log, swallow. DB write already succeeded; per-thread `/stream` subscribers still see `data-thread-title`.
- Writer push after `isStreamFinished()` → skip the chunk push (matches today's behavior).

### Adversarial / unexpected inputs
- Harness yields multiple `data-title-input` chunks → only the first triggers; rest are swallowed + `console.warn`.
- Harness yields `data-title-input` with empty `userMessage` → `genTitle`'s `hasUsableText` guard returns `"New chat"`.
- `currentThreadTitle` is `null`/`undefined` → treat as "not the default"; skip titling. Conservative: avoid overwriting a user-chosen title we couldn't read.
- Thread renamed between request start and title resolve → still write. The interceptor's decision is made at chunk-receive time using request-time `currentThreadTitle`. Matches today's behavior.

### Remote dispatch edge cases
- Daemon disconnects after emitting `data-title-input` but before main stream completes → interceptor already started `genTitle` in parallel; title persists independently. User gets a titled thread even if the run failed.
- Daemon crashes before emitting any chunks → no titling; thread stays `"New chat"`. Matches today's behavior for failed first turns.

### Backwards compatibility
- A Decopilot stream that started before deploy of this change finishes via the old code path. Coexistence is fine because the interceptor only acts on `data-title-input` chunks that the old code never emits.

## Testing

Per the repo's testing rules (`TESTING.md`): unit (pure logic, no DB/network/mocks) and E2E (Playwright, real Postgres + NATS).

### Unit tests

1. **`title-chunk.test.ts`** — `makeTitleInputChunk("hello")` returns the exact wire shape (type, data, transient).
2. **`title-generator.test.ts`** (extend existing) — assert the new fallback:
   - LLM returns empty title → falls back to `userMessage.slice(0, 10).trim()`.
   - User message is exactly 10 chars → returned verbatim.
   - User message under 10 chars → returned verbatim.
   - User message with leading whitespace → trimmed.
   - Empty user message → falls back to `"New chat"` (existing).
3. **`title-interceptor.test.ts`** — fake async iterable + stub deps (`genTitle`, `persistTitle` injected):
   - Non-`data-title-input` chunks pass through unchanged in 1-to-1 order.
   - First `data-title-input` chunk: swallowed; `genTitle` called with correct args.
   - Second `data-title-input` chunk: swallowed; `genTitle` NOT called again; `console.warn` fired.
   - `currentThreadTitle !== DEFAULT_THREAD_TITLE`: chunk swallowed; `genTitle` not called.
   - Title gen rejects: error logged; downstream chunks still pass through.
   - Source iterator completes → `handle.finish()` called.

### E2E tests

4. **Decopilot path** — existing tests; verify they still pass post-refactor.
5. **Claude Code path** — new `e2e/tests/claude-code-title.spec.ts`: start a thread, send one message, assert thread title changes from `"New chat"` within the stream window.
6. **Codex path** — new `e2e/tests/codex-title.spec.ts`: same shape as Claude Code.
7. **Remote dispatch** — verify against a linked agent (user-desktop dispatch). Reuses existing remote-cli e2e fixtures if available; otherwise skipped with a TODO referencing the dispatch path.

### Out of scope
- The exact title text produced by the LLM (non-deterministic).
- Latency of title generation (covered by the 10s grace period).
- Cross-tab SSE delivery (covered by existing `onTitleUpdated` tests).

## File-touch summary

**New files:**
- `apps/mesh/src/harnesses/title-chunk.ts`
- `apps/mesh/src/harnesses/title-chunk.test.ts`
- `apps/mesh/src/api/routes/decopilot/title-interceptor.ts`
- `apps/mesh/src/api/routes/decopilot/title-interceptor.test.ts`
- `apps/mesh/e2e/tests/claude-code-title.spec.ts`
- `apps/mesh/e2e/tests/codex-title.spec.ts`

**Modified files:**
- `apps/mesh/src/harnesses/decopilot/run-stream.ts` (remove ~60 lines; add ~3 lines)
- `apps/mesh/src/harnesses/decopilot/title-generator.ts` (change fallback from 60 chars to 10 chars)
- `apps/mesh/src/harnesses/decopilot/title-generator.test.ts` (extend fallback coverage)
- `apps/mesh/src/harnesses/claude-code/index.ts` (~5 lines added)
- `apps/mesh/src/harnesses/codex/index.ts` (~5 lines added)
- `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` (~10-line interceptor wiring)
