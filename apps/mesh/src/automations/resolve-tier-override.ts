/**
 * Resolve Tier Override
 *
 * Server-side counterpart to the chat path's "look up the live model when
 * Simple Mode is on" logic (see chat-context.tsx). When an automation row
 * carries `models.tier` and the org has Simple Mode enabled, we fetch the
 * full ModelInfo from the AI provider and translate it into the `thinking`
 * shape consumed by streamCore / model-compat / max-tokens cap.
 *
 * Returns null when:
 * - the automation has no tier intent (legacy / explicit pick)
 * - Simple Mode is disabled for the org
 * - the configured tier slot is unset
 *
 * Falls back to a slot-only override (no fresh metadata) if the AI
 * provider's listModels call fails — this matches the prior behavior of
 * "at least swap the credential and id" when the provider is flaky, but
 * still skips downstream capability gates which would break against a
 * model whose metadata we can't read.
 */

import type { MeshContext } from "@/core/mesh-context";
import type { TierOverride } from "./build-stream-request";

type SimpleModeChat = {
  enabled: boolean;
  chat?: Record<
    "fast" | "smart" | "thinking",
    { keyId: string; modelId: string; title?: string } | null
  > | null;
};

export async function resolveTierOverride(
  ctx: MeshContext,
  automation: { models: string; organization_id: string },
): Promise<TierOverride | null> {
  let parsed: { tier?: "fast" | "smart" | "thinking" };
  try {
    parsed = JSON.parse(automation.models);
  } catch {
    return null;
  }
  const tier = parsed.tier;
  if (!tier) return null;

  const settings = await ctx.storage.organizationSettings.get(
    automation.organization_id,
  );
  const simpleMode = settings?.simple_mode as SimpleModeChat | null | undefined;
  if (!simpleMode?.enabled) return null;
  const slot = simpleMode.chat?.[tier];
  if (!slot) return null;

  let title = slot.title ?? slot.modelId;
  let provider: string | null | undefined;
  let capabilities: TierOverride["thinking"]["capabilities"];
  let limits: TierOverride["thinking"]["limits"];

  try {
    const list = await ctx.aiProviders.listModels(
      slot.keyId,
      automation.organization_id,
    );
    const modelInfo = list.find((m) => m.modelId === slot.modelId);
    if (modelInfo) {
      title = modelInfo.title ?? title;
      provider = modelInfo.providerId;
      const caps = modelInfo.capabilities;
      capabilities =
        caps && caps.length > 0
          ? {
              vision:
                caps.includes("vision") || caps.includes("image") || undefined,
              text: caps.includes("text") || undefined,
              reasoning: caps.includes("reasoning") || undefined,
              file: caps.includes("file") || undefined,
            }
          : undefined;
      limits = modelInfo.limits
        ? {
            contextWindow: modelInfo.limits.contextWindow,
            maxOutputTokens: modelInfo.limits.maxOutputTokens ?? undefined,
          }
        : undefined;
    }
  } catch (err) {
    console.warn(
      `[resolveTierOverride] Failed to fetch model metadata for tier=${tier} keyId=${slot.keyId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return {
    credentialId: slot.keyId,
    thinking: {
      id: slot.modelId,
      title,
      ...(provider !== undefined ? { provider } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(limits ? { limits } : {}),
    },
  };
}
