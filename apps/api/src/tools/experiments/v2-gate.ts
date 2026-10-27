/**
 * Server gate for the rebuilt Experiments surface.
 *
 * The web tab picks its version from the same flag, but these tools are also
 * reachable over MCP, so the flag has to be enforced where the work happens
 * rather than only where the button is.
 */

import { ForbiddenError } from "../../core/access-control";
import type { StudioContext } from "../../core/studio-context";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";

export async function assertExperimentsV2(
  ctx: StudioContext,
  organizationId: string,
): Promise<void> {
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  if (
    !orgFlagEnabled(settings?.flags, "experiments_enabled") ||
    !orgFlagEnabled(settings?.flags, "experiments_v2_enabled")
  ) {
    throw new ForbiddenError(
      "The rebuilt Experiments tools need both `experiments_enabled` and `experiments_v2_enabled` organization flags",
    );
  }
}
