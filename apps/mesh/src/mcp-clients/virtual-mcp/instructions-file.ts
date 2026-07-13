/**
 * Resolves the agent's system prompt from its linked org-fs file
 * (`metadata.instructionsFile`). Read here (async, factory-side) — NOT inside
 * the synchronous `getInstructions()` — and stashed on the client options,
 * the same seam as the skills block, so it reaches both the cluster engine
 * and the sandbox/desktop daemon. Best-effort: any failure degrades to the
 * inline `metadata.instructions` mirror, never a failed client creation.
 */

import type { StudioContext } from "../../core/studio-context";
import {
  buildPublicOrgFs,
  isPublicVolume,
} from "../../file-storage/public-sets";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";

export async function loadInstructionsFileText(
  ctx: StudioContext,
  virtualMcp: VirtualMCPEntity,
): Promise<string | null> {
  const ref = virtualMcp.metadata?.instructionsFile;
  if (!ref) return null;
  try {
    // `public-*` volumes live under the shared public scope, not the org's.
    const orgFs = isPublicVolume(ref.volume)
      ? buildPublicOrgFs(ctx)
      : ctx.orgFs;
    if (!orgFs) return null;
    return new TextDecoder().decode(await orgFs.read(ref.volume, ref.path));
  } catch (err) {
    console.warn("[virtual-mcp] failed to read linked instructions file", {
      virtualMcpId: virtualMcp.id,
      volume: ref.volume,
      path: ref.path,
      err,
    });
    return null;
  }
}
