# Chat Run Status Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show accurate startup progress in the chat UI by streaming semantic `data-run-status` stages from the cluster Decopilot path and mapping those stages to business-friendly React copy.

**Architecture:** Add a small run-status stage contract on both sides of the stream. Backend producers publish hidden `data-run-status` chunks into the existing per-thread stream; the browser consumes those chunks into a `ThreadConnection.runStatusStage` store and does not feed them to AI SDK message folding. The durable projector also filters these chunks before reconstructing assistant messages, so run-status is live UI state rather than transcript content.

**Tech Stack:** TypeScript, Bun test runner, React 19, AI SDK `UIMessageChunk`, Hono routes, DBOS thread-gate workflow, NATS-backed `StreamBuffer`.

**Spec:** `docs/superpowers/specs/2026-06-17-chat-run-status-stages-design.md`

---

## File Structure

**Create:**
- `apps/mesh/src/web/components/chat/run-status.ts` - frontend stage enum, stage order, copy map, parser, and monotonic reducer.
- `apps/mesh/src/web/components/chat/run-status.test.ts` - pure unit tests for frontend copy, parsing, and monotonic behavior.
- `apps/mesh/src/api/routes/decopilot/run-status-stage.ts` - backend stage enum, chunk builder, chunk type guard, and safe publish helper.
- `apps/mesh/src/api/routes/decopilot/run-status-stage.test.ts` - pure unit tests for backend chunk building and safe publishing.

**Modify:**
- `apps/mesh/src/web/components/chat/store/thread-connection.ts` - add `runStatusStage` store, consume `data-run-status` chunks before message folding, set local `sending`/`received`, clear on terminal/error/stop/new run.
- `apps/mesh/src/web/components/chat/store/thread-connection.test.ts` - verify status transitions, monotonic replay handling, malformed chunks, and clearing.
- `apps/mesh/src/web/components/chat/chat-context.tsx` - expose `runStatusStage` through `ChatStreamContextValue`.
- `apps/mesh/src/web/components/chat/message/assistant.tsx` - replace the empty assistant waiting copy with stage-aware label/detail rendering; keep elapsed time, slow-turn text, and cancel.
- `apps/mesh/src/api/routes/decopilot/project-chunks.ts` - filter `data-run-status` chunks before projector folding.
- `apps/mesh/src/api/routes/decopilot/project-chunks.test.ts` - verify status chunks do not create persisted assistant parts.
- `apps/mesh/src/api/routes/decopilot/routes.ts` - emit `waiting-runner` after enqueue when stream buffer is available.
- `apps/mesh/src/dispatch-queue/thread-gate-workflow.ts` - emit `starting-run` when a cluster run enters dispatch.
- `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` - emit `gathering-context`, `preparing-tools`, `starting-assistant`, and `analyzing-scope` in the cluster Decopilot path.

## Global Constraints

- Run `bun run fmt` after code edits.
- Use `bun test <specific-file>` for the narrow tests in each task.
- Run `bun run check` before final handoff.
- Keep backend stream payloads to `{ type: "data-run-status", id: "run-status", data: { stage } }`; do not add label, detail, timestamp, or technical text to the wire shape.
- Do not add desktop stages in this implementation pass.
- Do not add a new SSE endpoint or status API.

---

## Task 1: Frontend Run Status Contract

**Files:**
- Create: `apps/mesh/src/web/components/chat/run-status.ts`
- Create: `apps/mesh/src/web/components/chat/run-status.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `apps/mesh/src/web/components/chat/run-status.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  RUN_STATUS_COPY,
  advanceRunStatusStage,
  parseRunStatusStageChunk,
  RUN_STATUS_STAGE_ORDER,
} from "./run-status";

describe("run status copy", () => {
  test("has user-facing copy for every ordered stage", () => {
    for (const stage of RUN_STATUS_STAGE_ORDER) {
      expect(RUN_STATUS_COPY[stage].label.length).toBeGreaterThan(0);
      expect(RUN_STATUS_COPY[stage].detail.length).toBeGreaterThan(0);
    }
  });

  test("uses the agreed cluster Decopilot labels", () => {
    expect(RUN_STATUS_COPY["waiting-runner"]).toEqual({
      label: "Waiting for an available runner",
      detail: "Waiting for the per-thread dispatch slot",
    });
    expect(RUN_STATUS_COPY["analyzing-scope"]).toEqual({
      label: "Analyzing scope",
      detail: "The model loop is running before first output",
    });
  });
});

describe("parseRunStatusStageChunk", () => {
  test("extracts a valid data-run-status stage", () => {
    expect(
      parseRunStatusStageChunk({
        type: "data-run-status",
        id: "run-status",
        data: { stage: "gathering-context" },
      }),
    ).toBe("gathering-context");
  });

  test("returns null for unknown or malformed chunks", () => {
    expect(parseRunStatusStageChunk({ type: "text-delta" })).toBeNull();
    expect(
      parseRunStatusStageChunk({
        type: "data-run-status",
        id: "run-status",
        data: { stage: "connecting-desktop" },
      }),
    ).toBeNull();
    expect(
      parseRunStatusStageChunk({
        type: "data-run-status",
        id: "run-status",
        data: {},
      }),
    ).toBeNull();
  });
});

describe("advanceRunStatusStage", () => {
  test("advances forward and ignores replayed older stages", () => {
    let current = advanceRunStatusStage(null, "received");
    expect(current).toBe("received");
    current = advanceRunStatusStage(current, "gathering-context");
    expect(current).toBe("gathering-context");
    current = advanceRunStatusStage(current, "starting-run");
    expect(current).toBe("gathering-context");
  });

  test("allows repeated stages", () => {
    expect(advanceRunStatusStage("preparing-tools", "preparing-tools")).toBe(
      "preparing-tools",
    );
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test apps/mesh/src/web/components/chat/run-status.test.ts
```

Expected: fail because `apps/mesh/src/web/components/chat/run-status.ts` does not exist.

- [ ] **Step 3: Implement the frontend contract**

Create `apps/mesh/src/web/components/chat/run-status.ts`:

```ts
export const RUN_STATUS_STAGE_ORDER = [
  "sending",
  "received",
  "waiting-runner",
  "starting-run",
  "gathering-context",
  "preparing-tools",
  "starting-assistant",
  "analyzing-scope",
  "choosing-next-steps",
] as const;

export type RunStatusStage = (typeof RUN_STATUS_STAGE_ORDER)[number];

export interface RunStatusCopy {
  label: string;
  detail: string;
}

export const RUN_STATUS_COPY: Record<RunStatusStage, RunStatusCopy> = {
  sending: {
    label: "Sending your message",
    detail: "Posting the message to the thread",
  },
  received: {
    label: "Request received",
    detail: "The run was accepted and queued",
  },
  "waiting-runner": {
    label: "Waiting for an available runner",
    detail: "Waiting for the per-thread dispatch slot",
  },
  "starting-run": {
    label: "Starting the run",
    detail: "A worker picked up the queued message",
  },
  "gathering-context": {
    label: "Gathering context",
    detail: "Loading history, memory, files, and agent context",
  },
  "preparing-tools": {
    label: "Preparing tools",
    detail: "Resolving models, permissions, MCP tools, and built-ins",
  },
  "starting-assistant": {
    label: "Starting the assistant",
    detail: "Opening the cluster Decopilot harness",
  },
  "analyzing-scope": {
    label: "Analyzing scope",
    detail: "The model loop is running before first output",
  },
  "choosing-next-steps": {
    label: "Choosing next steps",
    detail: "The assistant is planning the next action",
  },
};

const RUN_STATUS_STAGE_RANK = new Map<RunStatusStage, number>(
  RUN_STATUS_STAGE_ORDER.map((stage, index) => [stage, index]),
);

export function isRunStatusStage(value: unknown): value is RunStatusStage {
  return (
    typeof value === "string" &&
    RUN_STATUS_STAGE_RANK.has(value as RunStatusStage)
  );
}

export function parseRunStatusStageChunk(chunk: unknown): RunStatusStage | null {
  if (!chunk || typeof chunk !== "object") return null;
  const record = chunk as {
    type?: unknown;
    data?: { stage?: unknown };
  };
  if (record.type !== "data-run-status") return null;
  const stage = record.data?.stage;
  return isRunStatusStage(stage) ? stage : null;
}

export function advanceRunStatusStage(
  current: RunStatusStage | null,
  incoming: RunStatusStage,
): RunStatusStage {
  if (current === null) return incoming;
  const currentRank = RUN_STATUS_STAGE_RANK.get(current) ?? -1;
  const incomingRank = RUN_STATUS_STAGE_RANK.get(incoming) ?? -1;
  return incomingRank >= currentRank ? incoming : current;
}
```

- [ ] **Step 4: Verify the test passes**

Run:

```bash
bun test apps/mesh/src/web/components/chat/run-status.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/components/chat/run-status.ts apps/mesh/src/web/components/chat/run-status.test.ts
git commit -m "feat(chat): add run status stage copy"
```

---

## Task 2: ThreadConnection Run Status Store

**Files:**
- Modify: `apps/mesh/src/web/components/chat/store/thread-connection.ts`
- Modify: `apps/mesh/src/web/components/chat/store/thread-connection.test.ts`

- [ ] **Step 1: Add failing store tests**

Append these tests under the existing `describe("chunk handling", ...)` block in `apps/mesh/src/web/components/chat/store/thread-connection.test.ts`:

```ts
  test("tracks local sending and received states around POST /messages", async () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-post", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    const submitPromise = conn.submit(
      {
        kind: "message",
        message: {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      },
      baseOpts,
    );

    expect(conn.runStatusStage.get()).toBe("sending");
    await submitPromise;
    expect(conn.runStatusStage.get()).toBe("received");
  });

  test("consumes data-run-status without creating assistant content", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-chunk", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "gathering-context" },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("gathering-context");
    expect(conn.messages.get().filter((m) => m.role === "assistant")).toEqual(
      [],
    );
  });

  test("run status stage is monotonic across replayed chunks", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-monotonic", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "preparing-tools" },
    });
    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "starting-run" },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("preparing-tools");
  });

  test("clears run status when visible assistant content starts and on finish", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-clear", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "analyzing-scope" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("analyzing-scope");

    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "text-start", id: "p-1" });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: "hello" });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBeNull();

    stream.enqueue({ type: "text-end", id: "p-1" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBeNull();
  });
```

- [ ] **Step 2: Run the failing store tests**

Run:

```bash
bun test apps/mesh/src/web/components/chat/store/thread-connection.test.ts
```

Expected: fail because `ThreadConnection` has no `runStatusStage` store.

- [ ] **Step 3: Add run-status state to ThreadConnection**

In `apps/mesh/src/web/components/chat/store/thread-connection.ts`, add this import near the existing imports:

```ts
import {
  advanceRunStatusStage,
  parseRunStatusStageChunk,
  type RunStatusStage,
} from "../run-status";
```

Add a store next to `finishReason`:

```ts
  readonly runStatusStage = new Store<RunStatusStage | null>(null);
```

Add these private methods inside `ThreadConnection` before `handleChunk`:

```ts
  private setRunStatusStage(stage: RunStatusStage): void {
    this.runStatusStage.update((current) =>
      advanceRunStatusStage(current, stage),
    );
  }

  private clearRunStatusStage(): void {
    if (this.runStatusStage.get() !== null) {
      this.runStatusStage.set(null);
    }
  }
```

In `submit`, before `this.status.set({ kind: "submitted" });`, add:

```ts
    this.runStatusStage.set("sending");
```

In `post`, after the `if (!resp.ok) { ... }` block succeeds, add:

```ts
    this.runStatusStage.set("received");
```

In the `catch` branch of `submit`, before `this.failTo(e);`, add:

```ts
      this.clearRunStatusStage();
```

In `stop`, after the status reset, add:

```ts
    this.clearRunStatusStage();
```

In `handleChunk`, after the `waitingForNewRun` guard and before `observer?.onData`, add:

```ts
    const runStatusStage = parseRunStatusStageChunk(chunk);
    if (runStatusStage) {
      this.setRunStatusStage(runStatusStage);
      this.observer?.onData?.(
        chunk as Extract<UIMessageChunk, { type: `data-${string}` }>,
      );
      return;
    }
```

In `handleChunk`, when visible chunks arrive, clear status before folding. Add this after the `data-run-status` block:

```ts
    if (
      chunk.type !== "start" &&
      chunk.type !== "finish" &&
      !chunk.type.startsWith("data-") &&
      chunk.type !== "step-start"
    ) {
      this.clearRunStatusStage();
    }
```

In the `finish` branch inside `handleChunk`, add:

```ts
      this.clearRunStatusStage();
```

In `failTo`, before setting status error, add:

```ts
    this.clearRunStatusStage();
```

- [ ] **Step 4: Verify store tests pass**

Run:

```bash
bun test apps/mesh/src/web/components/chat/store/thread-connection.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/components/chat/store/thread-connection.ts apps/mesh/src/web/components/chat/store/thread-connection.test.ts
git commit -m "feat(chat): track run status stream state"
```

---

## Task 3: Render Run Status Copy in the Assistant Placeholder

**Files:**
- Modify: `apps/mesh/src/web/components/chat/chat-context.tsx`
- Modify: `apps/mesh/src/web/components/chat/message/assistant.tsx`

- [ ] **Step 1: Type the context addition**

In `apps/mesh/src/web/components/chat/chat-context.tsx`, add this import:

```ts
import type { RunStatusStage } from "./run-status";
```

Add a field to `ChatStreamContextValue`:

```ts
  runStatusStage: RunStatusStage | null;
```

Near the existing `useStore(conn.finishReason)` calls, add:

```ts
  const runStatusStage = useStore(conn.runStatusStage);
```

Add `runStatusStage` to `streamValue`:

```ts
    runStatusStage,
```

- [ ] **Step 2: Replace the placeholder renderer**

In `apps/mesh/src/web/components/chat/message/assistant.tsx`, add this import:

```ts
import { RUN_STATUS_COPY } from "../run-status.ts";
```

Replace `TypingIndicator` with this component:

```tsx
function RunStatusIndicator() {
  const stage = useOptionalChatStream()?.runStatusStage ?? null;
  const [fallbackStage, setFallbackStage] = useState<ThinkingStage>("planning");

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (stage !== null) return;
    const planningTimer = setTimeout(() => {
      setFallbackStage("thinking");
    }, PLANNING_DURATION);

    return () => {
      clearTimeout(planningTimer);
    };
  }, [stage]);

  if (stage !== null) {
    const copy = RUN_STATUS_COPY[stage];
    return (
      <div className="flex items-start gap-1.5 py-2 opacity-70">
        <Stars01
          className="text-muted-foreground shrink-0 animate-pulse mt-0.5"
          size={14}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[14px] text-muted-foreground shimmer">
            {copy.label}...
          </span>
          <span className="text-[12px] leading-4 text-muted-foreground/60">
            {copy.detail}
          </span>
        </span>
      </div>
    );
  }

  const config = THINKING_STAGES[fallbackStage];

  return (
    <div className="flex items-center gap-1.5 py-2 opacity-60">
      <span className="flex items-center gap-1.5">
        {config.icon}
        <span className="text-[14px] text-muted-foreground shimmer">
          {config.label}...
        </span>
      </span>
    </div>
  );
}
```

In `ThinkingState`, replace `<TypingIndicator />` with:

```tsx
        <RunStatusIndicator />
```

Change the content check from:

```ts
  const hasContent = message !== null && message.parts.length > 0;
```

to:

```ts
  const hasVisibleContent = message !== null && renderOrder.length > 0;
```

Then replace uses of `hasContent` in `MessageAssistant` with `hasVisibleContent`.

- [ ] **Step 3: Run targeted checks**

Run:

```bash
bun test apps/mesh/src/web/components/chat/run-status.test.ts apps/mesh/src/web/components/chat/store/thread-connection.test.ts
bun run check
```

Expected: tests pass and TypeScript accepts `runStatusStage` on `ChatStreamContextValue`.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/web/components/chat/chat-context.tsx apps/mesh/src/web/components/chat/message/assistant.tsx
git commit -m "feat(chat): render run status waiting copy"
```

---

## Task 4: Backend Run Status Chunk Helper

**Files:**
- Create: `apps/mesh/src/api/routes/decopilot/run-status-stage.ts`
- Create: `apps/mesh/src/api/routes/decopilot/run-status-stage.test.ts`

- [ ] **Step 1: Write the failing backend helper tests**

Create `apps/mesh/src/api/routes/decopilot/run-status-stage.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import {
  buildRunStatusChunk,
  isRunStatusChunk,
  publishRunStatusStage,
} from "./run-status-stage";

describe("buildRunStatusChunk", () => {
  test("builds a stage-only data-run-status chunk", () => {
    expect(buildRunStatusChunk("starting-run")).toEqual({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "starting-run" },
    });
  });
});

describe("isRunStatusChunk", () => {
  test("matches valid run status chunks only", () => {
    expect(isRunStatusChunk(buildRunStatusChunk("preparing-tools"))).toBe(true);
    expect(isRunStatusChunk({ type: "data-run-status", data: {} })).toBe(false);
    expect(
      isRunStatusChunk({
        type: "data-run-status",
        id: "run-status",
        data: { stage: "connecting-desktop" },
      }),
    ).toBe(false);
  });
});

describe("publishRunStatusStage", () => {
  test("publishes through StreamBuffer when available", async () => {
    const publishRawChunk = mock(() => Promise.resolve(true));
    await publishRunStatusStage(
      {
        publishRawChunk,
      },
      "thread-1",
      "gathering-context",
    );
    expect(publishRawChunk).toHaveBeenCalledWith("thread-1", {
      type: "data-run-status",
      id: "run-status",
      data: { stage: "gathering-context" },
    });
  });

  test("swallows publish failures", async () => {
    const publishRawChunk = mock(() => Promise.reject(new Error("nats down")));
    await expect(
      publishRunStatusStage({ publishRawChunk }, "thread-1", "starting-run"),
    ).resolves.toBeUndefined();
  });

  test("is a no-op without a stream buffer", async () => {
    await expect(
      publishRunStatusStage(undefined, "thread-1", "starting-run"),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the failing backend helper test**

Run:

```bash
bun test apps/mesh/src/api/routes/decopilot/run-status-stage.test.ts
```

Expected: fail because `run-status-stage.ts` does not exist.

- [ ] **Step 3: Implement the backend helper**

Create `apps/mesh/src/api/routes/decopilot/run-status-stage.ts`:

```ts
import type { UIMessageChunk } from "ai";
import type { StreamBuffer } from "./stream-buffer";

export const RUN_STATUS_STAGES = [
  "waiting-runner",
  "starting-run",
  "gathering-context",
  "preparing-tools",
  "starting-assistant",
  "analyzing-scope",
] as const;

export type BackendRunStatusStage = (typeof RUN_STATUS_STAGES)[number];

const STAGE_SET = new Set<string>(RUN_STATUS_STAGES);

export type RunStatusChunk = Extract<
  UIMessageChunk,
  { type: `data-${string}` }
> & {
  type: "data-run-status";
  id: "run-status";
  data: { stage: BackendRunStatusStage };
};

export function buildRunStatusChunk(
  stage: BackendRunStatusStage,
): RunStatusChunk {
  return {
    type: "data-run-status",
    id: "run-status",
    data: { stage },
  } as RunStatusChunk;
}

export function isRunStatusChunk(chunk: unknown): chunk is RunStatusChunk {
  if (!chunk || typeof chunk !== "object") return false;
  const record = chunk as {
    type?: unknown;
    data?: { stage?: unknown };
  };
  return (
    record.type === "data-run-status" &&
    typeof record.data?.stage === "string" &&
    STAGE_SET.has(record.data.stage)
  );
}

export async function publishRunStatusStage(
  streamBuffer: Pick<StreamBuffer, "publishRawChunk"> | undefined,
  taskId: string,
  stage: BackendRunStatusStage,
): Promise<void> {
  if (!streamBuffer) return;
  try {
    await streamBuffer.publishRawChunk(taskId, buildRunStatusChunk(stage));
  } catch {
    // Best-effort UI status. Never fail dispatch because a status hint failed.
  }
}
```

- [ ] **Step 4: Verify backend helper tests pass**

Run:

```bash
bun test apps/mesh/src/api/routes/decopilot/run-status-stage.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/api/routes/decopilot/run-status-stage.ts apps/mesh/src/api/routes/decopilot/run-status-stage.test.ts
git commit -m "feat(decopilot): add run status stream chunks"
```

---

## Task 5: Filter Run Status Chunks Out of Durable Projection

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/project-chunks.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/project-chunks.test.ts`

- [ ] **Step 1: Add a failing projector test**

Append to `apps/mesh/src/api/routes/decopilot/project-chunks.test.ts`:

```ts
  test("ignores data-run-status chunks when projecting assistant parts", async () => {
    const emitted: Array<{ id: string; parts?: unknown[] }> = [];

    await projectChunks({
      chunks: (async function* () {
        yield {
          type: "data-run-status",
          id: "run-status",
          data: { stage: "gathering-context" },
        } as UIMessageChunk;
        yield { type: "start", messageId: "m-1" } as UIMessageChunk;
        yield { type: "text-start", id: "txt" } as UIMessageChunk;
        yield {
          type: "text-delta",
          id: "txt",
          delta: "hello",
        } as UIMessageChunk;
        yield { type: "text-end", id: "txt" } as UIMessageChunk;
        yield { type: "finish", finishReason: "stop" } as UIMessageChunk;
      })(),
      persistence: {
        emitStepParts: async (message) => {
          emitted.push({ id: message.id, parts: message.parts });
        },
        emitFinal: async (message) => {
          emitted.push({ id: message.id, parts: message.parts });
        },
        emitError: async () => {},
      },
    });

    expect(
      emitted.flatMap((message) => message.parts ?? []).some((part) => {
        return (
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "data-run-status"
        );
      }),
    ).toBe(false);
  });
```

- [ ] **Step 2: Run the failing projector test**

Run:

```bash
bun test apps/mesh/src/api/routes/decopilot/project-chunks.test.ts
```

Expected: fail if `data-run-status` is handed to AI SDK folding before `start`, or if it appears in emitted parts.

- [ ] **Step 3: Filter run-status chunks in projectChunks**

In `apps/mesh/src/api/routes/decopilot/project-chunks.ts`, add:

```ts
import { isRunStatusChunk } from "./run-status-stage";
```

Inside `wrappedChunks`, replace:

```ts
      yield* options.chunks;
```

with:

```ts
      for await (const chunk of options.chunks) {
        if (isRunStatusChunk(chunk)) continue;
        yield chunk;
      }
```

- [ ] **Step 4: Verify projector tests pass**

Run:

```bash
bun test apps/mesh/src/api/routes/decopilot/project-chunks.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/api/routes/decopilot/project-chunks.ts apps/mesh/src/api/routes/decopilot/project-chunks.test.ts
git commit -m "feat(decopilot): ignore run status during projection"
```

---

## Task 6: Emit Cluster Run Status Stages

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/routes.ts`
- Modify: `apps/mesh/src/dispatch-queue/thread-gate-workflow.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts`

- [ ] **Step 1: Emit `waiting-runner` after enqueue**

In `apps/mesh/src/api/routes/decopilot/routes.ts`, add:

```ts
import { publishRunStatusStage } from "./run-status-stage";
```

After `await enqueueThreadRun(...)` in the POST `/messages` handler, add:

```ts
      if (target.sandboxProviderKind === "agent-sandbox") {
        await publishRunStatusStage(streamBuffer, taskId, "waiting-runner");
      }
```

The response should remain `202 { taskId }` even if status publishing fails; the helper swallows failures.

- [ ] **Step 2: Emit `starting-run` in the thread gate**

In `apps/mesh/src/dispatch-queue/thread-gate-workflow.ts`, add:

```ts
import { publishRunStatusStage } from "@/api/routes/decopilot/run-status-stage";
```

In `dispatchRunAndWaitStep`, after `const { request } = ctx;`, add:

```ts
  const taskId = request.taskId ?? ctx.threadId;
  if (request.target?.sandboxProviderKind !== "user-desktop") {
    await publishRunStatusStage(rt.deps.streamBuffer, taskId, "starting-run");
  }
```

Use the existing `taskId` variable in the rest of this function only if it reduces duplication; do not change routing logic.

- [ ] **Step 3: Emit prepare/assistant stages in dispatch-run**

In `apps/mesh/src/api/routes/decopilot/dispatch-run.ts`, add:

```ts
import { publishRunStatusStage } from "./run-status-stage";
```

After resolving `target` and before the large context-loading `Promise.all`, add:

```ts
    const shouldPublishRunStatus =
      target.sandboxProviderKind === "agent-sandbox" && harnessId === "decopilot";

    if (shouldPublishRunStatus) {
      await publishRunStatusStage(
        streamBuffer,
        input.taskId,
        "gathering-context",
      );
    }
```

After the context-loading `Promise.all` resolves and before resolving the effective virtual MCP, add:

```ts
    if (shouldPublishRunStatus) {
      await publishRunStatusStage(streamBuffer, input.taskId, "preparing-tools");
    }
```

Immediately before the `const dispatchHarnessChunks = async function* ()` declaration, add:

```ts
    if (shouldPublishRunStatus) {
      await publishRunStatusStage(
        streamBuffer,
        input.taskId,
        "starting-assistant",
      );
    }
```

Inside `dispatchHarnessChunks`, immediately before creating `InProcessSandboxClient`, add:

```ts
        if (shouldPublishRunStatus) {
          await publishRunStatusStage(
            streamBuffer,
            mem.thread.id,
            "analyzing-scope",
          );
        }
```

- [ ] **Step 4: Run targeted tests and typecheck**

Run:

```bash
bun test apps/mesh/src/api/routes/decopilot/run-status-stage.test.ts apps/mesh/src/api/routes/decopilot/project-chunks.test.ts
bun run check
```

Expected: tests pass and TypeScript accepts all imports and optional stream buffer calls.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/api/routes/decopilot/routes.ts apps/mesh/src/dispatch-queue/thread-gate-workflow.ts apps/mesh/src/api/routes/decopilot/dispatch-run.ts
git commit -m "feat(decopilot): stream cluster run status stages"
```

---

## Task 7: Final Verification

**Files:**
- Modify only if verification reveals a defect in the files touched above.

- [ ] **Step 1: Run all targeted tests**

Run:

```bash
bun test apps/mesh/src/web/components/chat/run-status.test.ts apps/mesh/src/web/components/chat/store/thread-connection.test.ts apps/mesh/src/api/routes/decopilot/run-status-stage.test.ts apps/mesh/src/api/routes/decopilot/project-chunks.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run formatting**

Run:

```bash
bun run fmt
```

Expected: completes successfully. If it modifies files, inspect `git diff` and include those formatting changes in the final commit.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run check
```

Expected: completes successfully.

- [ ] **Step 4: Run lint**

Run:

```bash
bun run lint
```

Expected: completes successfully.

- [ ] **Step 5: Commit final formatting or verification fixes**

If Step 2 modified files or Steps 3-4 required fixes:

```bash
git add apps/mesh/src/web/components/chat apps/mesh/src/api/routes/decopilot apps/mesh/src/dispatch-queue
git commit -m "fix(chat): polish run status stages"
```

If there are no changes, skip this commit.

---

## Self-Review Notes

Spec coverage:
- Backend streams only `stage`: Task 4 defines stage-only chunks; Task 6 emits them.
- React owns label/detail: Task 1 defines the copy map; Task 3 renders it.
- Existing stream channel only: Task 4 uses `StreamBuffer.publishRawChunk`; no new endpoint.
- Not transcript content: Task 2 consumes status chunks before browser folding; Task 5 filters projector folding.
- Cluster Decopilot only: Task 6 guards emissions to `agent-sandbox` Decopilot and excludes desktop stages.
- Monotonic replay handling: Task 1 reducer and Task 2 store tests cover it.

Type consistency:
- Frontend stage type is `RunStatusStage`.
- Backend stage type is `BackendRunStatusStage`.
- The shared chunk type name on the backend is `RunStatusChunk`.
- The stream store field is `runStatusStage`.

Risk called out for implementers:
- `data-run-status` may arrive before an AI SDK `start` chunk. That is intentional. Browser and projector code must filter it before AI SDK message folding.
