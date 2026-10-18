/**
 * Refresh one organization's repository briefs. The DBOS sweep calls this once
 * per org per tick; it never throws, so one repository's dead credential cannot
 * skip the others.
 */

import { memoryPath } from "@decocms/shared/memory";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { askFastTier } from "@/core/fast-tier-json";
import type { StudioContext } from "@/core/studio-context";
import { insightsClientForRepository } from "@/git-providers";
import type { RepositoryBriefStorage } from "@/storage/repository-briefs";
import { buildBrief, RepositoryBriefSchema } from "./brief";

export interface RefreshResult {
  built: number;
  unchanged: number;
  failed: number;
}

export async function refreshBriefsForOrg(
  ctx: StudioContext,
  briefs: RepositoryBriefStorage,
  organizationId: string,
  repositoryIds: string[],
  now: Date,
): Promise<RefreshResult> {
  const result: RefreshResult = { built: 0, unchanged: 0, failed: 0 };
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  if (!orgFlagEnabled(settings?.flags, "repo_upkeep")) return result;

  const readOrgMemory = async () => {
    if (!ctx.orgFs) return null;
    const bytes = await ctx.orgFs.read("home", memoryPath("organization", ""));
    return new TextDecoder().decode(bytes).trim() || null;
  };

  for (const repositoryId of repositoryIds) {
    try {
      const repository = await ctx.storage.repositories.get(
        repositoryId,
        organizationId,
      );
      if (!repository) continue;
      const previous = await briefs.get(repositoryId, organizationId);
      const client = await insightsClientForRepository(ctx, repository);
      const outcome = await buildBrief(
        client,
        previous && { headSha: previous.headSha, built: !!previous.brief },
        now,
        {
          ask: (system, prompt) =>
            askFastTier(
              ctx,
              organizationId,
              RepositoryBriefSchema,
              system,
              prompt,
              "[repo-upkeep] brief",
            ),
          readOrgMemory,
        },
      );
      if (outcome.kind === "built") {
        await briefs.saveBuilt(
          organizationId,
          repositoryId,
          outcome.headSha,
          outcome.brief,
          now,
        );
        result.built++;
      } else if (outcome.kind === "unchanged") {
        await briefs.markCurrent(organizationId, repositoryId, now);
        result.unchanged++;
      } else {
        await briefs.recordFailure(
          organizationId,
          repositoryId,
          outcome.reason,
          now,
        );
        result.failed++;
      }
    } catch (err) {
      result.failed++;
      await briefs
        .recordFailure(
          organizationId,
          repositoryId,
          err instanceof Error ? err.message : String(err),
          now,
        )
        .catch((writeErr) =>
          console.warn("[repo-upkeep] could not record failure", writeErr),
        );
    }
  }
  return result;
}
