/**
 * The project's Blocks v8 marker, `metadata.blocksMajor: 8`, with the record
 * of the CMS schema push it came from (`metadata.cmsSchemaPush`), and their
 * one writer that reads nothing: given a push's answer, bring both in line
 * with it. The hosted CMS's `deco schema push` (`PUT /api/cms/:site/schema`)
 * sets them from the schema pushed (no git read). The marker counts only
 * alongside that record (`isBlocksV8Project`).
 */

import {
  BLOCKS_MAJOR_METADATA_KEY,
  blocksV8Metadata,
  CMS_SCHEMA_PUSH_METADATA_KEY,
  type CmsSchemaPush,
  cmsSchemaPushOf,
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

/** What a schema push answered: whether it is v8, and where it is stored. */
export interface SchemaPushAnswer extends CmsSchemaPush {
  isV8: boolean;
}

function matches(
  metadata: Record<string, unknown> | null | undefined,
  answer: SchemaPushAnswer,
): boolean {
  if (!answer.isV8) {
    return (
      metadata?.[BLOCKS_MAJOR_METADATA_KEY] === undefined &&
      metadata?.[CMS_SCHEMA_PUSH_METADATA_KEY] === undefined
    );
  }
  const push = cmsSchemaPushOf(metadata);
  return (
    isBlocksV8Project(metadata) &&
    push?.site === answer.site &&
    push.sha256 === answer.sha256
  );
}

/**
 * Bring the marker and its push record in line with a schema push's answer:
 * a v8 schema sets both, any other clears both (a stale marker included). A
 * no-op when they already match. Patches only these keys, so a concurrent
 * `sandboxMap` write is never lost. Whether the stored keys now match the
 * answer: true on a no-op or a successful write, false when the write failed
 * (logged, never thrown).
 */
export async function syncBlocksMajorMarker(
  projects: BlocksMajorStorage,
  project: BlocksMajorProject,
  answer: SchemaPushAnswer,
  by: string,
): Promise<boolean> {
  if (matches(project.metadata, answer)) return true;
  try {
    return await projects.patchMetadata({
      id: project.id,
      organizationId: project.organizationId,
      set: answer.isV8 ? blocksV8Metadata(answer) : {},
      unset: answer.isV8
        ? []
        : [BLOCKS_MAJOR_METADATA_KEY, CMS_SCHEMA_PUSH_METADATA_KEY],
      by,
    });
  } catch (error) {
    console.warn("hosted: blocks v8 marker write failed", {
      organizationId: project.organizationId,
      projectId: project.id,
      isV8: answer.isV8,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
