/**
 * Org-wide agent pin (`connections.pinned`) is an admin/owner action.
 */

import { hasAdminRole } from "../../auth/roles";
import { ForbiddenError } from "../../core/access-control";
import type { StudioContext } from "../../core/studio-context";

export function requireOrgAdminForPinnedField(ctx: StudioContext): void {
  const role = ctx.access.getRole();
  if (!hasAdminRole(role)) {
    throw new ForbiddenError(
      "Only organization owners and admins can change org-wide pin status",
    );
  }
}
