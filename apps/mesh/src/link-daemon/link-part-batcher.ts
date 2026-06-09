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

const MAX_BATCH_ROWS = 512;

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
  private queue: Promise<void> = Promise.resolve();

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

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.firstFailure) throw this.firstFailure;
      await operation();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async postRows(rows: ThreadMessagePart[]): Promise<void> {
    if (rows.length === 0) return;
    if (this.firstFailure) throw this.firstFailure;

    for (let offset = 0; offset < rows.length; offset += MAX_BATCH_ROWS) {
      const chunk = rows.slice(offset, offset + MAX_BATCH_ROWS);
      try {
        await this.input.postBatch({
          batchId: `${this.input.runId}:${this.batchIndex++}`,
          rows: chunk,
          done: false,
        });
        this.builder.acknowledge(chunk);
      } catch (error) {
        this.firstFailure ??= error;
        throw error;
      }
    }
  }

  async emitStepParts(message: AnyMessage): Promise<void> {
    return this.enqueue(async () => {
      await this.postRows(this.pendingStepRows);
      this.pendingStepRows = this.builder.emitStepParts(message);
    });
  }

  async emitFinal(message: AnyMessage): Promise<void> {
    return this.enqueue(async () => {
      const rows = this.uniqueRows([
        ...this.pendingStepRows,
        ...this.builder.emitFinal(message),
      ]);
      this.pendingStepRows = [];
      await this.postRows(rows);
    });
  }

  async emitError(messageId: string, errorText: string): Promise<void> {
    return this.enqueue(async () => {
      const rows = this.uniqueRows([
        ...this.pendingStepRows,
        ...this.builder.emitError(messageId, errorText),
      ]);
      this.pendingStepRows = [];
      await this.postRows(rows);
    });
  }

  async flush(): Promise<void> {
    await this.queue;
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

  // Dispatch parse/provider errors are converted into error parts by
  // consumePartStream; postBatch failures are captured by RowBatchEmitter and
  // rethrown after the stream drains and the serialized emitter queue settles.
  await drain(uiStream).catch(() => {});
  await whenComplete;
  await emitter.flush();
  emitter.throwIfFailed();

  await input.postBatch({
    batchId: `${input.runId}:done`,
    rows: [],
    done: true,
  });
}
