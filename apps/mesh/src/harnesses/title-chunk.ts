/**
 * Wire format for transient title chunks.
 *
 * Harnesses generate titles with their own fast model and emit
 * `data-title-result`. The cluster interceptor persists that result and
 * rebroadcasts the UI-facing `data-thread-title` chunk.
 */
import type { UIMessageChunk } from "ai";

export const TITLE_INPUT_CHUNK_TYPE = "data-title-input" as const;
export const TITLE_RESULT_CHUNK_TYPE = "data-title-result" as const;

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

export interface TitleResultChunkData {
  title: string;
}

export interface TitleResultChunk {
  type: typeof TITLE_RESULT_CHUNK_TYPE;
  data: TitleResultChunkData;
  transient: true;
}

export function makeTitleInputChunk(userMessage: string): TitleInputChunk {
  return {
    type: TITLE_INPUT_CHUNK_TYPE,
    data: { userMessage },
    transient: true,
  };
}

export function makeTitleResultChunk(title: string): TitleResultChunk {
  return {
    type: TITLE_RESULT_CHUNK_TYPE,
    data: { title },
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

export function isTitleResultChunk(
  chunk: UIMessageChunk,
): chunk is UIMessageChunk & TitleResultChunk {
  return (chunk as { type?: string }).type === TITLE_RESULT_CHUNK_TYPE;
}
