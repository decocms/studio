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
 * Centralising the constant + constructor prevents the three harnesses
 * and the interceptor from drifting on string literals.
 */
import type { UIMessageChunk } from "ai";

export const TITLE_INPUT_CHUNK_TYPE = "data-title-input" as const;

export interface TitleInputChunkData {
  userMessage: string;
}

export function makeTitleInputChunk(userMessage: string): UIMessageChunk {
  return {
    type: TITLE_INPUT_CHUNK_TYPE,
    data: { userMessage },
    transient: true,
  } as UIMessageChunk;
}
