/**
 * Link ingest — the RETURN path of the pull-inverted local link.
 *
 * Preferred path: desktop posts deterministic `thread_message_parts` rows to
 * `/links/runs/:runId/parts` in short JSON batches.
 *
 * Transitional path: `/links/runs/:runId/stream` still accepts the old
 * long-lived SSE upload until all shipped daemons have moved to batched parts.
 *
 * SECURITY POSTURE (this phase): run fences are not minted yet, so the endpoint
 * is deliberately INERT — it requires an authenticated principal AND a non-null
 * current fence, rejecting otherwise. It becomes write-capable only once a later
 * phase mints fences in `prepareRun` and the daemon presents the token. NOTE for
 * that phase: also org-scope the fence lookup (`getRunFence` currently resolves
 * any thread id) and enforce thread ownership.
 */
import { Hono, type Context } from "hono";
import type { UIMessageChunk } from "ai";
import type { SSEEvent } from "@/event-bus";
import { parseDispatchSSEStream } from "@/harnesses/parse-dispatch-sse";
import { fenceMatches } from "@/storage/run-fence";
import { isCancelRequested } from "@/storage/cancel-flag";
import type { ThreadMessagePart } from "@/storage/fold-parts";
import {
  createDecopilotFinishEvent,
  createDecopilotThreadStatusEvent,
} from "@decocms/mesh-sdk";
import { PartEmitter } from "./part-emitter";
import { consumePartStream } from "./consume-part-stream";
import { linkIngestBatchSchema } from "./link-ingest-batch-schema";
import type { StreamBuffer } from "./stream-buffer";
import type { Env } from "../../hono-env";

export interface LinkIngestDeps {
  streamBuffer: StreamBuffer;
  sseHub?: { emit(orgId: string, event: SSEEvent): void };
}

type PartPayload = Record<string, unknown> & { type?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function chunksForPartRow(row: ThreadMessagePart): UIMessageChunk[] {
  if (row.kind === "finish" || !isRecord(row.payload)) return [];

  const part = row.payload as PartPayload;
  const type = stringField(part.type);
  if (!type) return [];

  if (type === "text") {
    return [
      { type: "text-start", id: row.id } as UIMessageChunk,
      {
        type: "text-delta",
        id: row.id,
        delta: typeof part.text === "string" ? part.text : "",
      } as UIMessageChunk,
      { type: "text-end", id: row.id } as UIMessageChunk,
    ];
  }

  if (type === "reasoning") {
    return [
      { type: "reasoning-start", id: row.id } as UIMessageChunk,
      {
        type: "reasoning-delta",
        id: row.id,
        delta: typeof part.text === "string" ? part.text : "",
      } as UIMessageChunk,
      { type: "reasoning-end", id: row.id } as UIMessageChunk,
    ];
  }

  if (type.startsWith("tool-") || type === "dynamic-tool") {
    const toolCallId = stringField(part.toolCallId) ?? row.id;
    const toolName =
      stringField(part.toolName) ??
      (type.startsWith("tool-") ? type.slice("tool-".length) : "dynamic");
    const chunks: UIMessageChunk[] = [];
    if ("input" in part) {
      chunks.push({
        type: "tool-input-available",
        toolCallId,
        toolName,
        input: part.input,
      } as UIMessageChunk);
    }
    if (part.state === "output-available") {
      chunks.push({
        type: "tool-output-available",
        toolCallId,
        output: part.output,
      } as UIMessageChunk);
    } else if (
      part.state === "output-error" ||
      part.state === "output-denied"
    ) {
      chunks.push({
        type: "tool-output-error",
        toolCallId,
        errorText:
          typeof part.errorText === "string"
            ? part.errorText
            : part.state === "output-denied"
              ? "Tool output denied"
              : "Tool output error",
      } as UIMessageChunk);
    }
    return chunks;
  }

  return [part as UIMessageChunk];
}

function liveChunksForRows(
  rows: ThreadMessagePart[],
  done: boolean,
): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [];
  const byMessage = new Map<string, ThreadMessagePart[]>();
  for (const row of rows) {
    if (row.role !== "assistant" || row.kind === "finish") continue;
    const group = byMessage.get(row.message_id) ?? [];
    group.push(row);
    byMessage.set(row.message_id, group);
  }

  for (const [messageId, messageRows] of byMessage) {
    chunks.push({ type: "start", messageId } as UIMessageChunk);
    chunks.push({ type: "start-step" } as UIMessageChunk);
    for (const row of messageRows.sort((a, b) => a.seq - b.seq)) {
      chunks.push(...chunksForPartRow(row));
    }
    chunks.push({ type: "finish-step" } as UIMessageChunk);
  }

  if (done) {
    chunks.push({ type: "finish" } as UIMessageChunk);
  }
  return chunks;
}

function streamFromChunks(chunks: UIMessageChunk[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function publishLiveChunks(
  deps: LinkIngestDeps,
  runId: string,
  orgId: string,
  chunks: UIMessageChunk[],
  signal: AbortSignal,
): Promise<void> {
  if (chunks.length === 0) return;
  const tail = await deps.streamBuffer.createTailStream(runId, signal, {
    deliverPolicy: "new",
    closeOnDone: true,
  });
  deps.streamBuffer.pump(streamFromChunks(chunks), runId, signal, orgId);
  if (tail) {
    await drain(tail).catch(() => {});
  }
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

  async function validateRunAccess(c: Context<Env>) {
    const ctx = c.get("meshContext");

    // resolveOrgFromPath does NOT require a principal — enforce auth here.
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    const runId = c.req.param("runId");
    if (!runId) {
      return c.json({ error: "invalid runId" }, 400);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      return c.json({ error: "invalid runId" }, 400);
    }
    const presented = c.req.header("x-fence-token") ?? null;

    // Cancel check MUST precede the fence check — a cancelled run must be
    // rejected even when the daemon presents a valid fence token.
    const cancelAt = await ctx.storage.threads.getCancelRequestedAt(runId);
    if (isCancelRequested(cancelAt)) {
      return c.json({ error: "cancelled" }, 409);
    }

    const current = await ctx.storage.threads.getRunFence(runId);
    // Inert until a fence is minted (a later phase): no fence ⇒ reject, so this
    // endpoint cannot write anything this phase.
    if (current === null) {
      return c.json({ error: "no active run fence" }, 409);
    }
    if (!fenceMatches(current, presented)) {
      return c.json({ error: "fenced" }, 409);
    }

    return { ctx, runId };
  }

  app.post("/links/runs/:runId/stream", async (c) => {
    const access = await validateRunAccess(c);
    if (access instanceof Response) return access;
    const { ctx, runId } = access;

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

    // `pump` is the SOLE consumer of `uiStream` (never tee it). Mirror
    // dispatch-run: a non-null tail means JetStream is live (pump consumes
    // uiStream + the tail mirrors it for /stream); a null tail means no
    // JetStream, so drain uiStream directly so parts still commit. Either way
    // `whenComplete` is the authoritative "all parts committed" signal.
    const tail = await deps.streamBuffer.createTailStream(
      runId,
      c.req.raw.signal,
      { deliverPolicy: "new", closeOnDone: true },
    );
    if (tail) {
      deps.streamBuffer.pump(uiStream, runId, c.req.raw.signal);
      await drain(tail).catch(() => {});
    } else {
      await drain(uiStream).catch(() => {});
    }
    await whenComplete;

    // Transition the run to terminal status so the gate's polling loop unblocks
    // (spec §L6). This is fungible-pod-safe: we write directly to durable storage
    // instead of calling runRegistry.execute() which only works on the in-memory
    // RunRegistry of the pod that owns the run (which may be a different pod).
    //
    // Mirrors only the durable side-effects from handleTerminalStatus in
    // run-reactor.ts: update threads.status + clear run_owner_pod/run_config/
    // run_started_at, then purge the live-edge stream buffer subject.
    //
    // Idempotent: setting an already-terminal status is a benign no-op UPDATE.
    // Invariant R3 (parts committed first) is upheld because we only reach here
    // after `await whenComplete`.
    await ctx.storage.threads.update(runId, {
      status: "completed",
      run_owner_pod: null,
      run_config: null,
      run_started_at: null,
    });
    deps.streamBuffer.purge(runId);

    return c.json({ ok: true });
  });

  app.post("/links/runs/:runId/parts", async (c) => {
    const access = await validateRunAccess(c);
    if (access instanceof Response) return access;
    const { ctx, runId } = access;

    let json: unknown;
    try {
      json = await c.req.json();
    } catch (error) {
      return c.json(
        {
          error: "bad batch",
          detail: error instanceof Error ? error.message : "Invalid JSON",
        },
        400,
      );
    }

    const parsed = linkIngestBatchSchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "bad batch", detail: parsed.error.message }, 400);
    }

    const rows = parsed.data.rows;
    const orgId = ctx.organization!.id;
    if (
      rows.some(
        (row) =>
          row.run_id !== runId ||
          row.thread_id !== runId ||
          row.org_id !== orgId,
      )
    ) {
      return c.json({ error: "row run mismatch" }, 400);
    }

    const insertedRows = await ctx.storage.threads
      .messageParts()
      .appendParts(rows);
    if (insertedRows.length > 0) {
      ctx.storage.threads.bumpProgress(runId).catch(() => {});
    }
    await publishLiveChunks(
      deps,
      runId,
      orgId,
      liveChunksForRows(insertedRows, false),
      c.req.raw.signal,
    );

    const mayComplete =
      parsed.data.done && (rows.length === 0 || insertedRows.length > 0);
    const completedThread = mayComplete
      ? await ctx.storage.threads.completeRunIfNotCompleted(runId)
      : null;

    if (completedThread) {
      await publishLiveChunks(
        deps,
        runId,
        orgId,
        liveChunksForRows([], true),
        c.req.raw.signal,
      );
      deps.streamBuffer.purge(runId);
      if (deps.sseHub) {
        deps.sseHub.emit(
          orgId,
          createDecopilotThreadStatusEvent(runId, "completed", {
            virtualMcpId: completedThread.virtual_mcp_id ?? undefined,
            createdBy: completedThread.created_by,
            triggerId: completedThread.trigger_id,
            title: completedThread.title,
            branch: completedThread.branch ?? null,
            createdAt: completedThread.created_at,
            updatedAt: completedThread.updated_at,
          }),
        );
        deps.sseHub.emit(orgId, createDecopilotFinishEvent(runId, "completed"));
      }
    }

    return c.json({
      ok: true,
      appended: rows.length,
      done: parsed.data.done,
    });
  });

  return app;
}
