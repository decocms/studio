/**
 * Wire format for the `data-title-input` transient chunk.
 *
 * Emitted by every harness at the top of its stream. Carries the user
 * message text. The cluster's title-interceptor (in dispatch-run.ts)
 * picks it up and runs `genTitle()` against the cluster-side
 * MeshProvider. Harnesses themselves stay title-agnostic.
 *
 * `transient: true` keeps the chunk out of the persisted assistant
 * message's `parts`.
 *
 * Centralising the constant + constructor + guard prevents the three
 * harnesses and the interceptor from drifting on string literals.
 */
import type { UIMessageChunk } from "ai";

export const TITLE_INPUT_CHUNK_TYPE = "data-title-input" as const;

export interface TitleInputChunkData {
  userMessage: string;
}

/** Narrow shape of the data-title-input transient chunk. Structurally
 *  compatible with one of the data-* variants of `UIMessageChunk`, so
 *  callers can yield it into an `AsyncIterable<UIMessageChunk>` directly
 *  (with a single `as UIMessageChunk` cast at the yield site if TS asks). */
export interface TitleInputChunk {
  type: typeof TITLE_INPUT_CHUNK_TYPE;
  data: TitleInputChunkData;
  transient: true;
}

export function makeTitleInputChunk(userMessage: string): TitleInputChunk {
  return {
    type: TITLE_INPUT_CHUNK_TYPE,
    data: { userMessage },
    transient: true,
  };
}

/** Type guard for distinguishing our chunk inside a generic
 *  `UIMessageChunk` stream — used by the cluster's title interceptor. */
export function isTitleInputChunk(
  chunk: UIMessageChunk,
): chunk is UIMessageChunk & TitleInputChunk {
  return (chunk as { type?: string }).type === TITLE_INPUT_CHUNK_TYPE;
}
