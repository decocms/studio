import type { UIMessage, UIMessageChunk } from "ai";
import type { StreamBuffer } from "./stream-buffer";

/**
 * Live mirror of a just-posted USER prompt onto the run stream.
 *
 * The run's JetStream subject carries only assistant/harness output, so a
 * SECOND viewer of a shared thread never saw the other user's prompt until a DB
 * refetch. We publish the materialized request message as a transient control
 * chunk at POST time (before the run's assistant chunks) so every tailing
 * viewer renders it live. It is deliberately fence-less and NOT persisted from
 * the stream — the durable copy is the `emitRequestMessage` DB write; the
 * projector filters this chunk out (see `project-chunks.ts`).
 *
 * Large prompts are handled for free: `publishRawChunk` → `serializeChunk`
 * fragments anything over `MAX_PUBLISH_BYTES` and drops over `MAX_CHUNKED_BYTES`.
 */
export const USER_MESSAGE_CHUNK_TYPE = "data-user-message";

export type UserMessageChunk = Extract<
  UIMessageChunk,
  { type: `data-${string}` }
> & {
  type: typeof USER_MESSAGE_CHUNK_TYPE;
  data: UIMessage;
};

export function buildUserMessageChunk(message: UIMessage): UserMessageChunk {
  return { type: USER_MESSAGE_CHUNK_TYPE, data: message } as UserMessageChunk;
}

export function isUserMessageControlChunk(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  return (chunk as { type?: unknown }).type === USER_MESSAGE_CHUNK_TYPE;
}

export async function publishUserMessage(
  streamBuffer: Pick<StreamBuffer, "publishRawChunk"> | undefined,
  taskId: string,
  message: UIMessage,
): Promise<void> {
  if (!streamBuffer) return;
  try {
    await streamBuffer.publishRawChunk(taskId, buildUserMessageChunk(message));
  } catch {
    // Best-effort live mirror. Never fail the POST because a viewer hint failed.
  }
}
