import {
  HARNESS_RUN_CONTEXT_MAX_BYTES,
  harnessRunContextSchema,
} from "@decocms/sandbox/dispatch/schemas";
import type { UIMessageChunk } from "ai";

/**
 * Check the run context a sandbox runner put on its chunks' metadata
 * (`messageMetadata.context`) before it is stored on the message's `finish`
 * row. The runner is another process on another release train, so its value
 * is external input: one that does not parse, or is larger than the cap, is
 * removed and the chunk goes on without it. The run never fails over it.
 *
 * A chunk without the field passes through untouched, which is every chunk of
 * a runner that predates it.
 */
export async function* withRunContext(
  chunks: AsyncIterable<UIMessageChunk>,
): AsyncIterable<UIMessageChunk> {
  for await (const chunk of chunks) {
    yield checked(chunk);
  }
}

function checked(chunk: UIMessageChunk): UIMessageChunk {
  if (!("messageMetadata" in chunk)) return chunk;
  const metadata = chunk.messageMetadata;
  if (typeof metadata !== "object" || metadata === null) return chunk;
  if (!("context" in metadata)) return chunk;
  const { context, ...rest } = metadata;
  const reason = rejection(context);
  if (!reason) return chunk;
  console.warn("[sandbox-dispatch] dropped the run context", { reason });
  return { ...chunk, messageMetadata: rest };
}

/** Why a context cannot be stored, or `null` when it can. */
function rejection(context: unknown): string | null {
  const parsed = harnessRunContextSchema.safeParse(context);
  if (!parsed.success) {
    return parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
      .join(", ");
  }
  const size = Buffer.byteLength(JSON.stringify(context));
  return size > HARNESS_RUN_CONTEXT_MAX_BYTES ? `${size} bytes` : null;
}
