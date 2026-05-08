import z from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
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
    enabled: config.enabled,
    chat: {
      fast: clearSlotIfMatches(config.chat.fast, keyId),
      smart: clearSlotIfMatches(config.chat.smart, keyId),
      thinking: clearSlotIfMatches(config.chat.thinking, keyId),
    },
    image: clearSlotIfMatches(config.image, keyId),
    webResearch: clearSlotIfMatches(config.webResearch, keyId),
  };
  const changed =
    next.chat.fast !== config.chat.fast ||
    next.chat.smart !== config.chat.smart ||
    next.chat.thinking !== config.chat.thinking ||
    next.image !== config.image ||
    next.webResearch !== config.webResearch;
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

    await ctx.storage.aiProviderKeys.delete(input.keyId, org.id);

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
