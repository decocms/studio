import type { ThreadMessagePart } from "@/storage/fold-parts";
import {
  consumePartStream,
  type PartEmitterLike,
} from "../api/routes/decopilot/consume-part-stream";
import type { LinkIngestBatch } from "../api/routes/decopilot/link-ingest-batch-schema";
import {
  type AnyMessage,
  PartRowBuilder,
} from "../api/routes/decopilot/part-row-builder";
import { parseDispatchSSEStream } from "../harnesses/parse-dispatch-sse";

export interface RelayDispatchSSEAsPartBatchesInput {
  dispatchBody: ReadableStream<Uint8Array>;
  runId: string;
  orgId: string;
  postBatch: (batch: LinkIngestBatch) => Promise<void>;
}

class RowBatchEmitter implements PartEmitterLike {
  private readonly builder: PartRowBuilder;
  private pendingStepRows: ThreadMessagePart[] = [];
  private batchIndex = 0;
  private firstFailure: unknown = null;

  constructor(private readonly input: RelayDispatchSSEAsPartBatchesInput) {
    this.builder = new PartRowBuilder({
      orgId: input.orgId,
      threadId: input.runId,
      runId: input.runId,
    });
  }

  private uniqueRows(rows: ThreadMessagePart[]): ThreadMessagePart[] {
    const seen = new Set<string>();
    const unique: ThreadMessagePart[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      unique.push(row);
    }
    return unique;
  }

  private async postRows(rows: ThreadMessagePart[]): Promise<void> {
    if (rows.length === 0) return;
    if (this.firstFailure) throw this.firstFailure;

    try {
      await this.input.postBatch({
        batchId: `${this.input.runId}:${this.batchIndex++}`,
        rows,
        done: false,
      });
      this.builder.acknowledge(rows);
    } catch (error) {
      this.firstFailure ??= error;
      throw error;
    }
  }

  async emitStepParts(message: AnyMessage): Promise<void> {
    await this.postRows(this.pendingStepRows);
    this.pendingStepRows = this.builder.emitStepParts(message);
  }

  async emitFinal(message: AnyMessage): Promise<void> {
    const rows = this.uniqueRows([
      ...this.pendingStepRows,
      ...this.builder.emitFinal(message),
    ]);
    this.pendingStepRows = [];
    await this.postRows(rows);
  }

  async emitError(messageId: string, errorText: string): Promise<void> {
    const rows = this.uniqueRows([
      ...this.pendingStepRows,
      ...this.builder.emitError(messageId, errorText),
    ]);
    this.pendingStepRows = [];
    await this.postRows(rows);
  }

  throwIfFailed(): void {
    if (this.firstFailure) throw this.firstFailure;
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

export async function relayDispatchSSEAsPartBatches(
  input: RelayDispatchSSEAsPartBatchesInput,
): Promise<void> {
  const emitter = new RowBatchEmitter(input);
  const chunks = parseDispatchSSEStream(input.dispatchBody);
  const { uiStream, whenComplete } = consumePartStream(chunks, emitter);

  await drain(uiStream).catch(() => {});
  await whenComplete;
  emitter.throwIfFailed();

  await input.postBatch({
    batchId: `${input.runId}:done`,
    rows: [],
    done: true,
  });
}
