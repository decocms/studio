/**
 * The project's Blocks v8 marker, `metadata.blocksMajor: 8`, and its one
 * writer that reads nothing: given an answer, bring the marker in line with
 * it. The hosted CMS's `deco schema push` sets it from the schema pushed
 * (no git read).
 */

import {
  BLOCKS_MAJOR_METADATA_KEY,
  BLOCKS_V8_MAJOR,
  isBlocksV8Project,
} from "@decocms/shared/blocks-major";

/** The one storage call the marker needs (`VirtualMCPStorage.patchMetadata`). */
export interface BlocksMajorStorage {
  patchMetadata(params: {
    id: string;
    organizationId: string;
    set: Record<string, unknown>;
    unset: string[];
    by: string;
  }): Promise<boolean>;
}

export interface BlocksMajorProject {
  id: string;
  organizationId: string;
  metadata: Record<string, unknown> | null | undefined;
}

/**
 * Bring the marker in line with the pushed schema's answer. A no-op when it already
 * matches. Single-key patch, so a concurrent `sandboxMap` write is never lost.
 * Whether the stored marker now matches the answer: true on a no-op or a
 * successful write, false when the write failed (logged, never thrown).
 */
export async function syncBlocksMajorMarker(
  projects: BlocksMajorStorage,
  project: BlocksMajorProject,
  isV8: boolean,
  by: string,
): Promise<boolean> {
  if (isBlocksV8Project(project.metadata) === isV8) return true;
  try {
    return await projects.patchMetadata({
      id: project.id,
      organizationId: project.organizationId,
      set: isV8 ? { [BLOCKS_MAJOR_METADATA_KEY]: BLOCKS_V8_MAJOR } : {},
      unset: isV8 ? [] : [BLOCKS_MAJOR_METADATA_KEY],
      by,
    });
  } catch (error) {
    console.warn("hosted: blocks v8 marker write failed", {
      organizationId: project.organizationId,
      projectId: project.id,
      isV8,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
