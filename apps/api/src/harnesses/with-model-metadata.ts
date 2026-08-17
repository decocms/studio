import type { UIMessageChunk } from "ai";

/**
 * Stamp the model a sandbox-hosted run actually used onto its assistant
 * message, in the shape Decopilot already emits (`metadata.models.thinking`).
 *
 * Decopilot writes that key from its own `messageMetadata` callback; the
 * claude-code harness has no such hook — its chunks come off the daemon over
 * SSE — so its finished messages carried `usage` (tokens, cost) and no model at
 * all. On one month of production task-board runs that was 328 of 391 billed
 * steps: every number attributable to an org and a task, none of it to a model.
 * Cost per model, and any experiment that moves a role onto a cheaper one, are
 * unanswerable without this.
 *
 * The model is not on the wire either — it reaches the pod as an environment
 * variable (`CLAUDE_CODE_MODEL`), so the dispatch client is the last place that
 * still knows it. Injected right after `start`, which is where Decopilot emits
 * the same key (a metadata chunk before `start` has no message to attach to and
 * is dropped), so both harnesses persist one shape and one query reads both.
 */
export async function* withModelMetadata(
  chunks: AsyncIterable<UIMessageChunk>,
  modelId: string | null | undefined,
  providerId: string,
): AsyncIterable<UIMessageChunk> {
  let stamped = false;
  for await (const chunk of chunks) {
    yield chunk;
    if (stamped || !modelId) continue;
    if ((chunk as { type?: string }).type !== "start") continue;
    stamped = true;
    yield {
      type: "message-metadata",
      messageMetadata: {
        models: {
          thinking: { id: modelId, title: modelId, provider: providerId },
        },
      },
    } as UIMessageChunk;
  }
}
