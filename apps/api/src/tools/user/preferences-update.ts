import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  ChatTierSchema,
  UserModelPreferencesSchema,
} from "@decocms/shared/organization/schema";
import {
  checkModelPermission,
  fetchModelPermissions,
} from "@/api/routes/decopilot/model-permissions";
import type { UserModelPreferences } from "@decocms/shared/organization/schema";

/**
 * Apply the role model allow-list to an incoming `tiers` blob.
 *
 * `tiers` is a full replace, so a slot the role no longer allows can arrive as
 * untouched residue from an earlier save. A newly picked disallowed model is
 * rejected; residue is dropped to null instead, because throwing on it would
 * lock the user out of editing their *other* tiers after a role narrows — and
 * dropping is what makes a revocation actually stick.
 *
 * @param allowedModels `undefined` means "all models allowed" (admin/owner).
 */
export function applyModelAllowList(
  input: UserModelPreferences["tiers"],
  stored: UserModelPreferences["tiers"] | undefined,
  allowedModels: string[] | undefined,
): UserModelPreferences["tiers"] {
  const tiers: UserModelPreferences["tiers"] = {};
  for (const tier of ChatTierSchema.options) {
    const slot = input[tier];
    if (
      !slot ||
      checkModelPermission(allowedModels, slot.keyId, slot.modelId)
    ) {
      tiers[tier] = slot;
      continue;
    }
    const prev = stored?.[tier];
    const unchanged =
      prev?.keyId === slot.keyId && prev?.modelId === slot.modelId;
    if (!unchanged) throw new Error("Model not allowed for your role");
    tiers[tier] = null;
  }
  return tiers;
}

export const USER_MODEL_PREFERENCES_UPDATE = defineTool({
  name: "USER_MODEL_PREFERENCES_UPDATE",
  description:
    "Set the calling user's personal chat tier → model overrides for the current organization. Only affects this user's chats; the org default and every non-chat path (automations, background tools) are unchanged. Omit a tier (or set it null) to fall back to the org default. Models the caller's role is not allowed to use are rejected.",
  annotations: {
    title: "Update User Model Preferences",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: UserModelPreferencesSchema,
  outputSchema: UserModelPreferencesSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = ctx.auth?.user?.id;
    if (!userId) throw new Error("No authenticated user in context");

    // Scoped strictly to the caller: a user can only ever write their own row.
    //
    // Enforce the role allow-list here, not only at send time: a saved slot
    // outlives a later narrowing of the role, and the sandbox commit-message /
    // review-judge paths resolve a tier without any dispatch gate.
    // `organization.role` is the path-resolved role for this org; the session's
    // ctx.auth.user?.role may belong to a different active org.
    const [allowedModels, stored] = await Promise.all([
      fetchModelPermissions(
        ctx.db,
        organization.id,
        organization.role ?? ctx.auth.user?.role,
      ),
      ctx.storage.userModelPreferences.get(userId, organization.id),
    ]);

    return await ctx.storage.userModelPreferences.upsert(
      userId,
      organization.id,
      { tiers: applyModelAllowList(input.tiers, stored?.tiers, allowedModels) },
    );
  },
});
