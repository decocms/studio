import z from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { HOSTED_PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { isPrivateUrl } from "../../mcp-clients/url-security";

export const providerKeyOutputSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  label: z.string(),
  presetId: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * An `openai-compatible` credential embeds a user-supplied baseUrl that the
 * server later fetches directly (listModels, chat completions) — reject one
 * targeting a private network at write time instead of letting it become an
 * SSRF probe into our own infra on first use.
 */
export function rejectPrivateOpenAiCompatibleBaseUrl(
  providerId: string,
  apiKey: string,
): void {
  if (providerId !== "openai-compatible") return;
  let baseUrl: unknown;
  try {
    baseUrl = (JSON.parse(apiKey) as { baseUrl?: unknown }).baseUrl;
  } catch {
    return;
  }
  if (typeof baseUrl === "string" && baseUrl && isPrivateUrl(baseUrl)) {
    throw new Error(
      "openai-compatible baseUrl must not target a private network",
    );
  }
}

export const AI_PROVIDER_KEY_CREATE = defineTool({
  name: "AI_PROVIDER_KEY_CREATE",
  description:
    "Store an API key for an AI provider. The key is encrypted at rest in the vault.",
  inputSchema: z.object({
    providerId: z.enum(HOSTED_PROVIDER_IDS),
    label: z.string().min(1).max(100),
    apiKey: z.string().min(1).max(4096),
    presetId: z.string().min(1).max(64).optional(),
  }),
  outputSchema: providerKeyOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    rejectPrivateOpenAiCompatibleBaseUrl(input.providerId, input.apiKey);

    const key = await ctx.storage.aiProviderKeys.create({
      providerId: input.providerId,
      label: input.label,
      apiKey: input.apiKey,
      organizationId: org.id,
      createdBy: ctx.auth.user!.id,
      presetId: input.presetId ?? null,
    });

    posthog.capture({
      distinctId: ctx.auth.user!.id,
      event: "ai_provider_key_created",
      groups: { organization: org.id },
      properties: {
        organization_id: org.id,
        provider_id: key.providerId,
        preset_id: key.presetId,
        key_id: key.id,
        label: key.label,
      },
    });

    return {
      id: key.id,
      providerId: key.providerId,
      label: key.label,
      presetId: key.presetId,
      createdAt: key.createdAt,
    };
  },
});
