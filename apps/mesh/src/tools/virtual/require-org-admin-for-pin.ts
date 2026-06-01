/**
 * Org-wide agent pin (`connections.pinned`) is an admin/owner action.
 */

import { ADMIN_ROLES, type BuiltinRole } from "../../auth/roles";
import { ForbiddenError } from "../../core/access-control";
import type { MeshContext } from "../../core/mesh-context";

export function requireOrgAdminForPinnedField(ctx: MeshContext): void {
  const role = ctx.access.getRole();
  if (!role || !ADMIN_ROLES.includes(role as BuiltinRole)) {
    throw new ForbiddenError(
      "Only organization owners and admins can change org-wide pin status",
    );
  }
}
