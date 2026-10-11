/**
 * The project's Blocks v8 marker: `metadata.blocksMajor: 8`, written by the
 * server only, so the web app and the sandbox proxy know a project is v8
 * before any thread exists (see `isBlocksV8Project` in
 * `@decocms/shared/thread/session-runtime`).
 *
 * Written only for orgs with `site_editor_content_protocol`, from code that
 * already reads main's `.deco/schema.gen.json` (project create/import, the
 * admin backfill, and write-through wherever `mainIsV8` runs). Cleared when
 * main is no longer v8. A v7 site never gets it. Best-effort everywhere: a
 * failed write is logged and never fails the request.
 */

import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import {
  BLOCKS_MAJOR_METADATA_KEY,
  isBlocksV8Project,
} from "@decocms/shared/thread/session-runtime";
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
 * Bring the marker in line with what main's schema says. A no-op when it
 * already matches. Single-key patch, so a concurrent `sandboxMap` write is
 * never lost.
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
      set: isV8 ? { [BLOCKS_MAJOR_METADATA_KEY]: 8 } : {},
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
 * For a just-created (or imported) project bound to a repository: read main's
 * schema once and set the marker when it is v8. Nothing happens unless the
 * hosted CMS can serve the project — the org has the content protocol, the
 * project owns its site id and a delivery bucket is configured (the same
 * preconditions as the hosted routes) — so the marker always means "the
 * hosted CMS serves this project". Never throws; callers don't await it.
 */
export async function markBlocksV8OnCreate(deps: {
  projects: BlocksMajorStorage;
  project: BlocksMajorProject;
  by: string;
  /** The org's flags (`organization_settings.flags`). */
  flags: () => Promise<Record<string, unknown> | null | undefined>;
  /**
   * The site id the project owns (`ownedProjectSite`), or null when it owns
   * none or no delivery bucket is configured.
   */
  hostedSite: () => Promise<string | null>;
  /** The project repo's content client, or null when it has none. */
  client: () => Promise<RepoContentClient | null>;
}): Promise<void> {
  try {
    if (!orgFlagEnabled(await deps.flags(), "site_editor_content_protocol")) {
      return;
    }
    if (!(await deps.hostedSite())) return;
    const client = await deps.client();
    if (!client) return;
    const isV8 = await mainIsV8(
      client,
      projectPackagePath(deps.project.metadata),
      await client.getDefaultBranch(),
    );
    await syncBlocksMajorMarker(deps.projects, deps.project, isV8, deps.by);
  } catch (error) {
    console.warn("hosted: blocks v8 detection failed", {
      organizationId: deps.project.organizationId,
      projectId: deps.project.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The site's folder inside the repo (`metadata.runtime.path`), or null. */
export function projectPackagePath(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const runtime = metadata?.runtime as { path?: string | null } | undefined;
  return runtime?.path?.replace(/^\/+|\/+$/g, "") || null;
}
