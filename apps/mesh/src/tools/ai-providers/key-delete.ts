import z from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import type {
  SimpleModeConfig,
  SimpleModeModelSlot,
} from "../../storage/types";

const clearSlotIfMatches = (
  slot: SimpleModeModelSlot | null,
  keyId: string,
): SimpleModeModelSlot | null => (slot && slot.keyId === keyId ? null : slot);

const clearSlotsForKey = (
  config: SimpleModeConfig,
  keyId: string,
): { config: SimpleModeConfig; changed: boolean } => {
  const next: SimpleModeConfig = {
    tiers: {
      fast: clearSlotIfMatches(config.tiers.fast, keyId),
      smart: clearSlotIfMatches(config.tiers.smart, keyId),
      thinking: clearSlotIfMatches(config.tiers.thinking, keyId),
      image: clearSlotIfMatches(config.tiers.image, keyId),
      web_research: clearSlotIfMatches(config.tiers.web_research, keyId),
    },
  };
  const changed =
    next.tiers.fast !== config.tiers.fast ||
    next.tiers.smart !== config.tiers.smart ||
    next.tiers.thinking !== config.tiers.thinking ||
    next.tiers.image !== config.tiers.image ||
    next.tiers.web_research !== config.tiers.web_research;
  return { config: next, changed };
};

export const AI_PROVIDER_KEY_DELETE = defineTool({
  name: "AI_PROVIDER_KEY_DELETE",
  description: "Delete a stored AI provider API key. Cannot be undone.",
  inputSchema: z.object({
    keyId: z.string().describe("The provider key ID to delete"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    // Clear simple-mode slots referencing this key BEFORE deleting it. If the
    // settings upsert fails, the key is still present and the operation can be
    // retried — the alternative ordering would leave slots pointing at a
    // non-existent key, which breaks chat/automations until manual cleanup.
    const settings = await ctx.storage.organizationSettings.get(org.id);
    if (settings?.simple_mode) {
      const { config, changed } = clearSlotsForKey(
        settings.simple_mode,
        input.keyId,
      );
      if (changed) {
        await ctx.storage.organizationSettings.upsert(org.id, {
          simple_mode: config,
        });
      }
    }

    await ctx.storage.aiProviderKeys.delete(input.keyId, org.id);

    posthog.capture({
      distinctId: ctx.auth.user!.id,
      event: "ai_provider_key_deleted",
      groups: { organization: org.id },
      properties: {
        organization_id: org.id,
        key_id: input.keyId,
      },
    });

    return { success: true };
  },
});
