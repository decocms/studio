/**
 * The project's Blocks v8 marker: `metadata.blocksMajor: 8`, the cached answer
 * of `isV8Schema` (`@decocms/shared/blocks-major`) on main's
 * `.deco/schema.gen.json`. The web app and the sandbox proxy read it to know
 * a project is v8 before any thread exists (`isBlocksV8Project`).
 *
 * Only code that just ran the predicate on main (`mainIsV8`) writes it: project
 * create/import, the refresh when a project is opened, the admin backfill, and
 * the hosted routes that read main's schema anyway. Every org gets it: v8 is
 * per site, on as soon as main's schema says so. Cleared when main is no
 * longer v8, so a v7 site never has it. Best-effort everywhere: a failed write
 * is logged and never fails the request.
 */

import {
  BLOCKS_MAJOR_METADATA_KEY,
  BLOCKS_V8_MAJOR,
  isBlocksV8Project,
} from "@decocms/shared/blocks-major";
import { delay } from "@decocms/shared/std";
import type { RepoContentClient } from "@/git-providers";
import { mainIsV8 } from "./scope";

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
 * Bring the marker in line with `mainIsV8`'s answer. A no-op when it already
 * matches. Single-key patch, so a concurrent `sandboxMap` write is never lost.
 */
export async function syncBlocksMajorMarker(
  projects: BlocksMajorStorage,
  project: BlocksMajorProject,
  isV8: boolean,
  by: string,
): Promise<void> {
  if (isBlocksV8Project(project.metadata) === isV8) return;
  try {
    await projects.patchMetadata({
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
  }
}

/**
 * Run `mainIsV8` for a project bound to a repository and sync its marker.
 * The answer, or null when the project has no repository or main couldn't be
 * read (the marker is then left as it is). Never throws.
 */
export async function refreshBlocksMajorMarker(deps: {
  projects: BlocksMajorStorage;
  project: BlocksMajorProject;
  by: string;
  /** The project repo's content client, or null when it has none. */
  client: () => Promise<RepoContentClient | null>;
}): Promise<boolean | null> {
  try {
    const client = await deps.client();
    if (!client) return null;
    const isV8 = await mainIsV8(
      client,
      projectPackagePath(deps.project.metadata),
      await client.getDefaultBranch(),
    );
    await syncBlocksMajorMarker(deps.projects, deps.project, isV8, deps.by);
    return isV8;
  } catch (error) {
    console.warn("hosted: blocks v8 detection failed", {
      organizationId: deps.project.organizationId,
      projectId: deps.project.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * {@link refreshBlocksMajorMarker} for a just-created (or imported) project,
 * waiting at most `timeoutMs`: a v8 project then comes back already marked, so
 * its first thread opens in Fast Preview. A slower answer still lands in the
 * background (the refresh on open covers a repo seeded later). The answer, or
 * null when it isn't known in time.
 */
export async function markBlocksV8OnCreate(
  deps: Parameters<typeof refreshBlocksMajorMarker>[0],
  timeoutMs = CREATE_DETECTION_TIMEOUT_MS,
): Promise<boolean | null> {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      refreshBlocksMajorMarker(deps),
      delay(timeoutMs, { signal: timeout.signal }).then(() => null),
    ]);
  } finally {
    timeout.abort();
  }
}

const CREATE_DETECTION_TIMEOUT_MS = 3_000;

/** The site's folder inside the repo (`metadata.runtime.path`), or null. */
export function projectPackagePath(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const runtime = metadata?.runtime as { path?: string | null } | undefined;
  return runtime?.path?.replace(/^\/+|\/+$/g, "") || null;
}
