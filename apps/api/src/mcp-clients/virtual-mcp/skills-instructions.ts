/**
 * Renders the `<available-skills>` catalog block for an agent's served
 * instructions. Built here (async, server-side) — NOT inside the synchronous
 * `getInstructions()` — because enumerating skills reads org-fs. The factory
 * stashes the result on the client so `getInstructions()` can append it
 * synchronously, and it then reaches every run path (cluster engine + desktop
 * daemon) the same way the `<knowledge>` block does.
 */

import { buildSkillsBlock } from "@/harnesses/lib/decopilot/skills-block";
import type { StudioContext } from "../../core/studio-context";
import { buildSkillCatalog } from "../../file-storage/skill-catalog";
import { orgFsSandboxPath } from "../../file-storage/mount/provisioning";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";

/**
 * Build the catalog block, or null when there are no skills / no org context.
 * The skills the user attached to this agent are the SAME entries the catalog
 * already enumerates (the attach picker draws from the same home + public-set
 * scopes), so they aren't listed separately — they're flagged inline as
 * user-configured so the model prefers them. Never throws — a storage hiccup
 * degrades to "no skills block", never a failed client creation.
 */
export async function renderSkillsCatalogBlock(
  ctx: StudioContext,
  virtualMcp: VirtualMCPEntity,
): Promise<string | null> {
  const orgId = ctx.organization?.id;
  if (!orgId) return null;
  try {
    const all = await buildSkillCatalog(ctx, orgId);

    // Skills the user attached to this agent, matched to catalog entries by
    // resolved sandbox path → their ids get the user-configured callout.
    const attached = new Set(
      (virtualMcp.metadata?.knowledge ?? [])
        .filter((k) => k.kind === "skill")
        .map((k) => orgFsSandboxPath(k.volume, k.path)),
    );

    // `disable-model-invocation` skills are for a person to reach for, so they
    // are not advertised: listing one puts its description in the cached
    // prefix of every run in the org, which is the implicit context they exist
    // to avoid. Attaching one to this agent IS a person reaching for it, so
    // that brings it back. The `/` menu reads the catalog unfiltered.
    const entries = all.filter(
      (e) => !e.disableModelInvocation || attached.has(e.sandboxPath),
    );
    if (entries.length === 0) return null;

    const configuredIds = entries
      .filter((e) => attached.has(e.sandboxPath))
      .map((e) => e.id);

    return buildSkillsBlock(
      entries.map((e) => ({
        id: e.id,
        description: e.description,
        source: e.source,
      })),
      configuredIds,
    );
  } catch (err) {
    console.warn("[skill-catalog] failed to render skills block", err);
    return null;
  }
}
