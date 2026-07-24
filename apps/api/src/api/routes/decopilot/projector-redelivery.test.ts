/**
 * Redelivery behavior of the durable projector (the `consumeRunProjection`
 * step) — the invariants that make DBOS re-running an interrupted projection
 * attempt safe, and the terminal behavior when redelivery can no longer
 * succeed because the JetStream subject lost data.
 *
 * Context (stg incident 2026-07-14, thread d9ef33e5): a gate workflow orphaned
 * on a dead executor was recovered hours late. Recovery re-runs the WHOLE
 * consume step from seq 1 (`DeliverPolicy.All`, no journaled cursor). That is
 * safe — parts persist incrementally at step boundaries with idempotent row
 * ids — but only while the subject still retains every chunk. The stream has
 * a 4GB `DiscardPolicy.Old` cap, a 24h age cap, and `purgeRun` on terminal:
 * a late re-attempt can meet a truncated (or fully purged) subject, which
 * today surfaces as a generic contiguity error → misleading
 * `failed(projection)` + pointless DBOS step retries that can never succeed.
 *
 * Three groups:
 *  1. Churn convergence — pins the existing invariant: interrupt + full
 *     redelivery from seq 1 converges to the exact same rows (no dup, no loss).
 *  2. Truncated redelivery — typed `StreamGapError` instead of a generic
 *     error, and the workflow body maps it to a clean, NON-retried terminal.
 *  3. Idle timeout on an already-terminal same-fence run — clean no-op
 *     (crash between terminal-write and step-journal + purge race), not a
 *     spurious liveness re-fail.
 */
import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import { createProjectorChunkStreamFromMessages } from "./projector-chunk-stream";
import { StreamGapError, StreamIdleTimeoutError } from "./nats-chunk-source";
import { projectChunks } from "./project-chunks";
import { createRunPersistence } from "./run-persistence";
import { synthesizedErrorMessageId } from "./message-ids";
import {
  runProjectorWorkflowBody,
  type ProjectorWorkflowInput,
  type ProjectorWorkflowRuntime,
} from "./projector-workflow";

const RUN_ID = "run_1";
const FENCE = "fence_a";
const enc = new TextEncoder();

type Msg = {
  subject: string;
  data: Uint8Array;
  headers?: { get(name: string): string | undefined };
};

function msg(msgId: string, payload: unknown): Msg {
  const all: Record<string, string> = { "Nats-Msg-Id": msgId };
  return {
    subject: `decopilot.stream.${RUN_ID}`,
    data: enc.encode(JSON.stringify(payload)),
    headers: { get: (name) => all[name] },
  };
}

/** Producer-side encode: chunks at fence seqs 1..n, then the fenced done. */
function encodeRun(chunks: UIMessageChunk[], startSeq = 1): Msg[] {
  const msgs = chunks.map((chunk, i) =>
    msg(`${RUN_ID}:${FENCE}:${startSeq + i}`, { p: chunk }),
  );
  const finalSeq = startSeq + chunks.length - 1;
  msgs.push(
    msg(`${RUN_ID}:${FENCE}:done:${finalSeq}`, { done: true, finalSeq }),
  );
  return msgs;
}

/** A two-step assistant turn — step boundaries make `emitStepParts` fire
 *  mid-fold, which is the incremental durable checkpoint under test. */
function twoStepTurn(): UIMessageChunk[] {
  return [
    { type: "start", messageId: "msg_a" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "hello" },
    { type: "text-end", id: "t1" },
    { type: "finish-step" },
    { type: "start-step" },
    { type: "text-start", id: "t2" },
    { type: "text-delta", id: "t2", delta: " world" },
    { type: "text-end", id: "t2" },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
  ] as UIMessageChunk[];
}

interface FakeRow {
  id: string;
  message_id: string;
  created_at: string;
  [key: string]: unknown;
}

/** ON-CONFLICT-faithful in-memory storage: `appendParts` keeps the FIRST
 *  write per row id (`ON CONFLICT DO NOTHING`), `replaceMessageParts`
 *  deletes-then-inserts the message's rows — the two behaviors redelivery
 *  correctness rests on. */
function fakeStorage() {
  const rows = new Map<string, FakeRow>();
  const storage = {
    maxCreatedAtMsForMessage: async () => null,
    maxCreatedAtMsForRun: async () => {
      let max: number | null = null;
      for (const r of rows.values()) {
        const t = new Date(r.created_at).getTime();
        if (max === null || t > max) max = t;
      }
      return max;
    },
    appendParts: async (incoming: FakeRow[]) => {
      for (const r of incoming) if (!rows.has(r.id)) rows.set(r.id, r);
    },
    replaceMessageParts: async (
      _threadId: string,
      messageId: string,
      incoming: FakeRow[],
    ) => {
      for (const [id, r] of rows)
        if (r.message_id === messageId) rows.delete(id);
      for (const r of incoming) rows.set(r.id, r);
    },
  } as unknown as SqlThreadMessagePartStorage;
  return { rows, storage };
}

/** One projection attempt, exactly as `projectFromJetStreamStep` wires it:
 *  fresh persistence (fresh emitter/base), full pipeline from the delivered
 *  messages, `replaceFinal: true`. */
async function projectionAttempt(
  messages: AsyncIterable<Msg> | Iterable<Msg>,
  storage: SqlThreadMessagePartStorage,
) {
  const persistence = await createRunPersistence({
    messageParts: storage,
    orgId: "org_1",
    runId: RUN_ID,
    replaceFinal: true,
  });
  return projectChunks({
    chunkStream: createProjectorChunkStreamFromMessages({
      messages,
      runId: RUN_ID,
      fenceToken: FENCE,
    }),
    persistence,
    originalMessages: [],
    // Production-faithful: the projector passes the deterministic per-fence
    // error id so re-attempts dedupe the synthesized error part.
    errorMessageId: synthesizedErrorMessageId(RUN_ID, FENCE),
  });
}

/** Rows keyed by id with volatile ordering fields stripped, for convergence
 *  comparison across attempts (created_at bases legitimately differ between
 *  a first write and a redelivered one — first write wins per row). */
function snapshot(rows: Map<string, FakeRow>) {
  return [...rows.values()]
    .map(({ id, message_id, ...rest }) => ({
      id,
      message_id,
      part: JSON.stringify(rest.part ?? rest.content ?? null),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe("projector redelivery — churn convergence (existing invariant)", () => {
  test("interrupt mid-fold + full redelivery from seq 1 converges to identical rows", async () => {
    // Control: one uninterrupted projection.
    const control = fakeStorage();
    const controlResult = await projectionAttempt(
      encodeRun(twoStepTurn()),
      control.storage,
    );
    expect(controlResult.finishReason).toBe("stop");
    expect(control.rows.size).toBeGreaterThan(0);

    // Churn: attempt 1 dies mid-step (executor killed) after step 1 finished.
    const churn = fakeStorage();
    const all = encodeRun(twoStepTurn());
    const dyingSource = (async function* () {
      // Deliver through the first finish-step (chunk seq 6), then die.
      yield* all.slice(0, 6);
      throw new Error("executor died");
    })();
    await expect(projectionAttempt(dyingSource, churn.storage)).rejects.toThrow(
      "executor died",
    );
    // The durable checkpoint: step-1 parts persisted BEFORE the crash.
    expect(churn.rows.size).toBeGreaterThan(0);

    // Attempt 2: DBOS recovery re-runs the step; JetStream redelivers ALL
    // retained messages from seq 1.
    const second = await projectionAttempt(all, churn.storage);
    expect(second.finishReason).toBe("stop");

    // Attempt 3: crash-after-completion-before-journal → one more full replay.
    const third = await projectionAttempt(all, churn.storage);
    expect(third.finishReason).toBe("stop");

    // CONTENT rows converge exactly (no dup, no loss). The synthesized error
    // message attempt 1 persisted is excluded here — its cleanup is the
    // workflow body's job on a successful terminal (clearSynthesizedError,
    // asserted below), not the fold's.
    const errorMessageId = synthesizedErrorMessageId(RUN_ID, FENCE);
    const contentRows = (rows: Map<string, FakeRow>) =>
      new Map([...rows].filter(([, r]) => r.message_id !== errorMessageId));
    expect(snapshot(contentRows(churn.rows))).toEqual(
      snapshot(contentRows(control.rows)),
    );
    // The interrupted attempt DID leave the synthesized error message behind
    // at this layer — the reason the workflow-level cleanup below must exist.
    expect(
      [...churn.rows.values()].some((r) => r.message_id === errorMessageId),
    ).toBe(true);
  });
});

describe("projector redelivery — truncated subject", () => {
  test("head-truncated redelivery surfaces a typed StreamGapError", async () => {
    // Retention (4GB DiscardOld / 24h age) discarded seqs 1-2 before a late
    // re-attempt: delivery starts at seq 3.
    const { storage } = fakeStorage();
    const truncated = encodeRun(twoStepTurn()).slice(2);
    const err = await projectionAttempt(truncated, storage).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StreamGapError);
    expect((err as StreamGapError).expectedSeq).toBe(1);
    expect((err as StreamGapError).gotSeq).toBe(3);
  });

  test("done whose finalSeq exceeds the last delivered chunk is a gap too", async () => {
    const { storage } = fakeStorage();
    const chunks = twoStepTurn();
    const msgs = encodeRun(chunks);
    // Drop the tail chunks but keep the done (tail truncation mid-subject).
    const truncatedTail = [...msgs.slice(0, 4), msgs[msgs.length - 1]!];
    const err = await projectionAttempt(truncatedTail, storage).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StreamGapError);
  });
});

// ---------------------------------------------------------------------------
// Workflow-body mapping — injected-runtime-fake style (projector-workflow.test)
// ---------------------------------------------------------------------------

interface FakeCall {
  kind: string;
  reason?: string;
  failKind?: string;
}

function makeRuntime(opts: { status: string }) {
  const calls: FakeCall[] = [];
  const rt: ProjectorWorkflowRuntime = {
    getJetStream: () => null as never,
    getJetStreamManager: async () => null as never,
    resolveRun: async () => ({
      orgId: "org_1",
      createdBy: "user_1",
      version: 2,
      status: opts.status,
      runFenceToken: FENCE,
      title: null,
    }),
    messageParts: null as never,
    completeRunIfNotCompleted: async () => {
      calls.push({ kind: "complete" });
      return { status: "completed" };
    },
    markRunRequiresAction: async () => {
      calls.push({ kind: "requires-action" });
      return { status: "requires_action" };
    },
    markRunFailed: async (_runId, _orgId, reason, kind) => {
      calls.push({ kind: "fail", reason, failKind: kind });
      return { status: "failed" };
    },
    persistTitle: async () => {},
    onTitleUpdated: async () => {},
    bumpProgress: async () => {},
    recordCompleted: async () => {
      calls.push({ kind: "record-complete" });
    },
    recordFailed: async ({ reason, kind }) => {
      calls.push({ kind: "record-fail", reason, failKind: kind });
    },
    purgeRun: async () => {
      calls.push({ kind: "purge" });
    },
    clearSynthesizedError: async () => {
      calls.push({ kind: "clear-error" });
    },
  };
  return { rt, calls };
}

const input: ProjectorWorkflowInput = { runId: RUN_ID, fenceToken: FENCE };

describe("projector workflow — StreamGapError terminal mapping", () => {
  test("truncation fails the run cleanly WITHOUT rethrowing (no retry burn)", async () => {
    const { rt, calls } = makeRuntime({ status: "in_progress" });
    const projectFn = async () => {
      throw new StreamGapError(1, 3);
    };
    // Resolves — the step must SUCCEED: redelivery can never reconstruct a
    // truncated subject, so retrying is pure burn. (A successful projection
    // of a failed run, same shape as the in-band harness-error branch.)
    await expect(
      runProjectorWorkflowBody(input, rt, projectFn),
    ).resolves.toBeUndefined();
    const fail = calls.find((c) => c.kind === "fail");
    expect(fail?.failKind).toBe("projection");
    expect(fail?.reason).toMatch(/truncated/);
    expect(calls.some((c) => c.kind === "record-fail")).toBe(true);
    expect(calls.some((c) => c.kind === "purge")).toBe(true);
  });

  test("gap on an already-settled same fence: benign, clears bubble, no fail", async () => {
    // A purge (terminal or next-turn dispatch-start) racing an in-flight or
    // redelivered projection on the shared per-thread subject beheads chunks and
    // surfaces a gap AFTER the run already reached terminal for this fence. That
    // is not a truncation — drop the spurious "missing seq" bubble the fold just
    // wrote and return cleanly instead of stamping a failure over a settled run.
    const { rt, calls } = makeRuntime({ status: "completed" });
    const projectFn = async () => {
      throw new StreamGapError(61, null);
    };
    await expect(
      runProjectorWorkflowBody(input, rt, projectFn),
    ).resolves.toBeUndefined();
    expect(calls.filter((c) => c.kind === "fail")).toEqual([]);
    expect(calls.some((c) => c.kind === "record-fail")).toBe(false);
    expect(calls.some((c) => c.kind === "clear-error")).toBe(true);
    expect(calls.some((c) => c.kind === "purge")).toBe(true);
  });
});

describe("projector workflow — stale synthesized error cleanup", () => {
  test("successful terminal clears the prior attempt's synthesized error", async () => {
    const { rt, calls } = makeRuntime({ status: "in_progress" });
    const projectFn = async () => ({
      chunkCount: 1,
      attempts: 1,
      outcome: {
        failed: false,
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finalParts: [],
      },
    });
    await runProjectorWorkflowBody(input, rt, projectFn);
    expect(calls.some((c) => c.kind === "clear-error")).toBe(true);
  });

  test("failed terminal keeps the error part (it IS the run's content)", async () => {
    const { rt, calls } = makeRuntime({ status: "in_progress" });
    const projectFn = async () => ({
      chunkCount: 1,
      attempts: 1,
      outcome: {
        failed: true,
        finishReason: undefined,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finalParts: [],
      },
    });
    await runProjectorWorkflowBody(input, rt, projectFn);
    expect(calls.some((c) => c.kind === "clear-error")).toBe(false);
    expect(calls.some((c) => c.kind === "fail")).toBe(true);
  });
});

describe("projector workflow — idle timeout on an already-terminal run", () => {
  test("same-fence terminal run: clean no-op, no spurious liveness fail", async () => {
    // Crash between terminal-write and step-journal (or purge raced): the
    // re-attempt reads an empty subject → idle timeout — but the run is
    // already settled. Must return cleanly, not re-fail it.
    const { rt, calls } = makeRuntime({ status: "completed" });
    const projectFn = async () => {
      throw new StreamIdleTimeoutError(600_000);
    };
    await expect(
      runProjectorWorkflowBody(input, rt, projectFn),
    ).resolves.toBeUndefined();
    expect(calls.filter((c) => c.kind === "fail")).toEqual([]);
    expect(calls.some((c) => c.kind === "purge")).toBe(true);
  });

  test("in_progress run: liveness failure + rethrow unchanged", async () => {
    const { rt, calls } = makeRuntime({ status: "in_progress" });
    const projectFn = async () => {
      throw new StreamIdleTimeoutError(600_000);
    };
    await expect(
      runProjectorWorkflowBody(input, rt, projectFn),
    ).rejects.toThrow(/no output/);
    const fail = calls.find((c) => c.kind === "fail");
    expect(fail?.failKind).toBe("liveness");
  });
});
