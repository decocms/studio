/**
 * Renders the `<available-skills>` catalog block for an agent's served
 * instructions. Built here (async, server-side) — NOT inside the synchronous
 * `getInstructions()` — because enumerating skills reads org-fs. The factory
 * stashes the result on the client so `getInstructions()` can append it
 * synchronously, and it then reaches every run path (cluster engine + desktop
 * daemon) the same way the `<knowledge>` block does.
 */

import { buildSkillsBlock } from "@decocms/harness/decopilot/skills-block";
import type { StudioContext } from "../../core/studio-context";
import { buildSkillCatalog } from "../../file-storage/skill-catalog";
import { orgFsSandboxPath } from "../../file-storage/mount/provisioning";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";

/**
 * Build the catalog block, or null when there are no skills / no org context.
 * Skills already attached to the agent (the `<knowledge>` block lists those)
 * are excluded to avoid double-listing. Never throws — a storage hiccup
 * degrades to "no skills block", never a failed client creation.
 */
export async function renderSkillsCatalogBlock(
  ctx: StudioContext,
  virtualMcp: VirtualMCPEntity,
): Promise<string | null> {
  const orgId = ctx.organization?.id;
  if (!orgId) return null;
  const orgSlug = ctx.organization?.slug ?? "";
  try {
    const entries = await buildSkillCatalog(ctx, orgId, orgSlug);
    if (entries.length === 0) return null;

    // Exclude skills already surfaced by the <knowledge> block (attached
    // skills), matched by their resolved sandbox path.
    const attached = new Set(
      (virtualMcp.metadata?.knowledge ?? [])
        .filter((k) => k.kind === "skill")
        .map((k) => orgFsSandboxPath(k.volume, k.path, orgSlug)),
    );

    return buildSkillsBlock(
      entries
        .filter((e) => !attached.has(e.sandboxPath))
        .map((e) => ({
          id: e.id,
          description: e.description,
          source: e.source,
        })),
    );
  } catch (err) {
    console.warn("[skill-catalog] failed to render skills block", err);
    return null;
  }
}
