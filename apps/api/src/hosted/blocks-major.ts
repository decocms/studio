/**
 * The project's Blocks v8 marker: `metadata.blocksMajor: 8`, the cached answer
 * of `isV8Schema` (`@decocms/shared/blocks-major`) on main's
 * `.deco/schema.gen.json`. Only the server reads it, as a cache: a new
 * thread's default runtime (`defaultThreadRuntime`) and the admin backfill.
 * The web app never decides from it: it reads main's schema over the content
 * protocol (`schema.get` on `/decofile/…/rpc`, which answers any site) and
 * runs `isV8Schema` itself, and every hosted gate recomputes it
 * ({@link projectMainIsV8}).
 *
 * Only code that just ran the predicate on main (`mainIsV8`) writes it: project
 * create/import (in the background), thread create when the answer decides
 * the runtime stamp, the admin backfill, and the hosted routes that read
 * main's schema anyway (the editor's own read of main's schema on open is
 * one of them, so opening a project refreshes it; no route of its own). Every org gets it: v8 is
 * per site, on as soon as main's schema says so. Cleared when main is no
 * longer v8, so a v7 site never has it. Best-effort everywhere: a failed write
 * is logged and never fails the request.
 */

import {
  BLOCKS_MAJOR_METADATA_KEY,
  BLOCKS_V8_MAJOR,
  isBlocksV8Project,
} from "@decocms/shared/blocks-major";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
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

/**
 * `isV8Schema` on main's schema, read fresh (`mainIsV8`), with the marker
 * synced to it. `"no-repository"` when the project has no repository (so no
 * main to read: never a v8 site). Throws when main couldn't be read, so a
 * caller can tell "v7" from "unknown"; a failed marker write is only logged
 * (the answer still stands: it is main's, not the marker's).
 */
async function readMainBlocksMajor(deps: {
  projects: BlocksMajorStorage;
  project: BlocksMajorProject;
  by: string;
  /** The project repo's content client, or null when it has none. */
  client: () => Promise<RepoContentClient | null>;
}): Promise<{ isV8: boolean; stored: boolean } | "no-repository"> {
  const client = await deps.client();
  if (!client) return "no-repository";
  const isV8 = await mainIsV8(
    client,
    projectPackagePath(deps.project.metadata),
    await client.getDefaultBranch(),
  );
  const stored = await syncBlocksMajorMarker(
    deps.projects,
    deps.project,
    isV8,
    deps.by,
  );
  return { isV8, stored };
}

/**
 * {@link readMainBlocksMajor} for the callers that act on the marker (project
 * create, thread create). The answer, or null when the project has no
 * repository, main couldn't be read (the marker is then left as it is) or
 * the marker write failed (so a caller never acts on a marker the database
 * doesn't have). Never throws.
 */
export async function refreshBlocksMajorMarker(
  deps: Parameters<typeof readMainBlocksMajor>[0],
): Promise<boolean | null> {
  try {
    const read = await readMainBlocksMajor(deps);
    if (read === "no-repository") return null;
    return read.stored ? read.isV8 : null;
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
 * The hosted gates' question: is this project's main a Blocks v8 one right
 * now? Always `isV8Schema` on main's schema, never the marker alone, so a
 * project whose marker is missing (seeded after create, never opened) or
 * stale (main went back to v7) gets the right answer. The marker is only the
 * hint `mainIsV8` reuses its last minute's answer under (`recentIf`): at most
 * one head read per minute per repository while they agree, a fresh read as
 * soon as they don't (the editor's open just wrote a new answer). The answer is written
 * through to the marker when there is a user to attribute it to.
 */
export async function projectMainIsV8(deps: {
  /** Where the marker is written through; no write without it. */
  projects?: BlocksMajorStorage;
  project: BlocksMajorProject;
  by: string | null | undefined;
  client: RepoContentClient;
  mainBranch: string;
  /**
   * Read main's head even when the last minute's answer agrees with the
   * marker (an ETag'd 304 on an unchanged main): the editor's read of main's
   * schema when a project opens, so a push to main is picked up at once.
   */
  fresh?: boolean;
}): Promise<boolean> {
  const isV8 = await mainIsV8(
    deps.client,
    projectPackagePath(deps.project.metadata),
    deps.mainBranch,
    deps.fresh ? {} : { recentIf: isBlocksV8Project(deps.project.metadata) },
  );
  if (deps.projects && deps.by) {
    await syncBlocksMajorMarker(deps.projects, deps.project, isV8, deps.by);
  }
  return isV8;
}

/**
 * {@link refreshBlocksMajorMarker}, waiting at most `timeoutMs`. Thread create
 * runs it before stamping the runtime of a project the answer matters for
 * ({@link threadRuntimeAwaitsBlocksMajor}), so a v8 site whose marker isn't
 * written yet (repo seeded after create, a project from before the backfill)
 * still gets a `cms` thread. A slower answer still lands in the background.
 * The answer, or null when it isn't known in time.
 */
export async function refreshBlocksMajorMarkerWithin(
  deps: Parameters<typeof refreshBlocksMajorMarker>[0],
  timeoutMs = THREAD_CREATE_DETECTION_TIMEOUT_MS,
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

const THREAD_CREATE_DETECTION_TIMEOUT_MS = 3_000;

/**
 * Whether a new thread's runtime stamp hangs on the v8 check: the project has a
 * repository and a preview server, isn't marked yet, and its Fast Preview
 * switch is off. Only then can the answer turn a `sandbox` stamp into `cms`
 * (`defaultThreadRuntime`), so every other thread create, v7 included, skips
 * the check and makes no extra reads.
 */
export function threadRuntimeAwaitsBlocksMajor(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return (
    !!metadata?.repository &&
    !!resolvePreviewServerUrl(metadata) &&
    !isBlocksV8Project(metadata) &&
    metadata?.fastPreview !== true
  );
}

/**
 * The project metadata a new thread's default runtime is read from: the stored
 * one, plus the marker when the bounded v8 check (run only when
 * {@link threadRuntimeAwaitsBlocksMajor}) just found main is v8 and persisted
 * it. Every other case returns the stored metadata untouched, with no reads.
 */
export async function metadataForThreadRuntime<
  M extends Record<string, unknown>,
>(
  deps: Parameters<typeof refreshBlocksMajorMarker>[0] & {
    project: BlocksMajorProject & { metadata: M | null | undefined };
  },
  timeoutMs?: number,
): Promise<M | null | undefined> {
  const metadata = deps.project.metadata;
  if (!threadRuntimeAwaitsBlocksMajor(metadata)) return metadata;
  const isV8 = await refreshBlocksMajorMarkerWithin(deps, timeoutMs);
  return isV8
    ? { ...(metadata as M), [BLOCKS_MAJOR_METADATA_KEY]: BLOCKS_V8_MAJOR }
    : metadata;
}

/** The site's folder inside the repo (`metadata.runtime.path`), or null. */
export function projectPackagePath(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const runtime = metadata?.runtime as { path?: string | null } | undefined;
  return runtime?.path?.replace(/^\/+|\/+$/g, "") || null;
}
