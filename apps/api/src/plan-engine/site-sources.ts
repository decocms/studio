/**
 * Before each analysis the app discovers the store — domain, Deco Analytics
 * slug and repository — from the site project; the profile form is only an
 * override. A failure goes into `errors` and never aborts the analysis.
 */

import {
  pickStudioProject,
  type StudioProject,
  type VirtualMcpItem,
} from "./studio-project.ts";
import type { SiteSources } from "./types.ts";

const errorOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export async function detectSiteSources(opts: {
  /** The org's Virtual MCPs. */
  projects: () => Promise<readonly VirtualMcpItem[]>;
  orgSlug: string;
  /** Already-known domain (profile), to choose among several projects. */
  domain: string | null;
  now: string;
}): Promise<{ sources: SiteSources; project: StudioProject | null }> {
  const errors: string[] = [];
  let project: StudioProject | null = null;
  try {
    project = pickStudioProject(await opts.projects(), {
      orgSlug: opts.orgSlug,
      domain: opts.domain,
    });
    if (!project) errors.push("nenhum projeto de site nesta org do Studio");
  } catch (err) {
    errors.push(`projeto do Studio: ${errorOf(err)}`);
  }

  return {
    project,
    sources: {
      detected_at: opts.now,
      studio_project: project
        ? {
            id: project.id,
            title: project.title,
            site_slug: project.site_slug,
            domain: project.domain,
            runtime: project.runtime,
          }
        : null,
      repository: project?.repository ?? null,
      errors,
    },
  };
}
