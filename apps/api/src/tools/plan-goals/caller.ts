import { hasAdminRole } from "@decocms/shared/auth/roles";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";

export interface PlanGoalCaller {
  orgId: string;
  userId: string;
  admin: boolean;
}

/** The org and the signed-in caller every goal tool acts for. */
export async function caller(ctx: StudioContext): Promise<PlanGoalCaller> {
  requireAuth(ctx);
  await ctx.access.check();
  const org = requireOrganization(ctx);
  const userId = getUserId(ctx);
  if (!userId) throw new Error("A signed-in user is required");
  return { orgId: org.id, userId, admin: hasAdminRole(ctx.access.getRole()) };
}
