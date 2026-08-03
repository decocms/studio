import type { StudioContext } from "@/core/studio-context";
import {
  ChatTierSchema,
  type SimpleModeTier,
} from "@decocms/shared/organization/schema";
import {
  isHostedProviderId,
  pickSimpleModeDefaults,
  type AiProviderKey,
  type AiProviderModel,
  type SimpleModeDefaults,
  type SimpleModeModelSlot,
} from "@decocms/shared/sdk";

export class TierUnavailableError extends Error {
  constructor(public tier: SimpleModeTier) {
    super(
      `No model available for tier "${tier}". Connect a provider or configure the tier in organization settings.`,
    );
    this.name = "TierUnavailableError";
  }
}

export class SpecificModelCredentialUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpecificModelCredentialUnavailableError";
  }
}

export interface ModelMetadata {
  title?: string;
  providerId?: string | null;
  capabilities?: string[];
  limits?: { contextWindow: number; maxOutputTokens?: number | null } | null;
}

export interface ResolvedTier {
  credentialId: string;
  modelId: string;
  modelMeta: ModelMetadata;
}

export interface ResolveTierOptions {
  /**
   * Layer the caller's personal chat-tier override (USER_MODEL_PREFERENCES)
   * on top of the org slot. Opt-in, and only ever honored for fast/smart/
   * thinking.
   *
   * Off by default because most `resolveTier` callers are not "this user's
   * chat": automations run as their creator, and the task-board super agent,
   * background tools, commit-message suggestion and review judge all resolve a
   * tier on someone's behalf. An admin who sets an automation to "smart" must
   * not have it silently change model when its creator later edits a personal
   * chat preference. Interactive chat (decopilot/routes.ts) opts in.
   */
  applyUserPrefs?: boolean;
}

const METADATA_FETCH_TIMEOUT_MS = 5_000;

async function fetchModelList(
  ctx: StudioContext,
  keyId: string,
  orgId: string,
): Promise<AiProviderModel[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const list = await Promise.race([
      ctx.aiProviders.listModels(keyId, orgId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("listModels timeout")),
          METADATA_FETCH_TIMEOUT_MS,
        );
      }),
    ]);
    // Backend's ModelInfo and SDK's AiProviderModel are structurally compatible
    // for the fields pickSimpleModeDefaults reads (modelId, capabilities, title).
    return list as unknown as AiProviderModel[];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pickSlotForTier(
  tier: SimpleModeTier,
  defaults: SimpleModeDefaults,
): SimpleModeModelSlot | null {
  switch (tier) {
    case "fast":
      return defaults.chat.fast;
    case "smart":
      return defaults.chat.smart;
    case "thinking":
      return defaults.chat.thinking;
    case "image":
      return defaults.image;
    case "web_search":
      return defaults.webSearch;
    case "deep_research":
      return defaults.deepResearch;
  }
}

function metaFromCatalogEntry(
  catalog: AiProviderModel[],
  modelId: string,
  fallbackTitle?: string,
): ModelMetadata {
  const found = catalog.find((m) => m.modelId === modelId);
  return {
    title: found?.title ?? fallbackTitle ?? modelId,
    providerId: found?.providerId,
    capabilities: found?.capabilities,
    limits: found?.limits ?? null,
  };
}

export async function resolveTier(
  ctx: StudioContext,
  tier: SimpleModeTier,
  opts?: ResolveTierOptions,
): Promise<ResolvedTier> {
  const orgId = ctx.organization?.id;
  if (!orgId) throw new Error("resolveTier called without an organization");

  const settings = await ctx.storage.organizationSettings.get(orgId);
  const orgSlot = settings?.simple_mode?.tiers?.[tier] ?? null;

  // Per-user override, opt-in and chat-tiers-only (see ResolveTierOptions).
  // Skipping the read entirely when it can't win also keeps a dispatch from
  // issuing three throwaway queries for image/web_search/deep_research.
  const userId = ctx.auth?.user?.id;
  const chatTier = ChatTierSchema.safeParse(tier);
  const userSlot =
    opts?.applyUserPrefs && chatTier.success && userId
      ? ((await ctx.storage.userModelPreferences.get(userId, orgId))?.tiers?.[
          chatTier.data
        ] ?? null)
      : null;

  const keys = (
    await ctx.storage.aiProviderKeys.list({ organizationId: orgId })
  ).filter((key) => isHostedProviderId(key.providerId));

  // Prefer the user override, then the org slot; take the first whose key is
  // still live. A slot pointing at a deleted key is skipped so resolution
  // degrades cleanly: user → org → default-pick.
  // ponytail: read-time liveness check is why deleting a provider key needs no
  // sweep of every user's saved override — a stale slot just falls through.
  for (const slot of [userSlot, orgSlot]) {
    if (slot && keys.some((k) => k.id === slot.keyId)) {
      const catalog = await fetchModelList(ctx, slot.keyId, orgId).catch(
        () => [] as AiProviderModel[],
      );
      return {
        credentialId: slot.keyId,
        modelId: slot.modelId,
        modelMeta: metaFromCatalogEntry(catalog, slot.modelId, slot.title),
      };
    }
  }

  // Fallback: tier slot is unset (or references a deleted key). Build the
  // SDK's default-pick from the org's connected providers + their actual
  // model catalogs. This matches what the settings page would auto-populate,
  // so chat works on first connect even before the admin saves anything.
  if (keys.length === 0) throw new TierUnavailableError(tier);

  const modelsByKeyId: Record<string, AiProviderModel[]> = {};
  await Promise.all(
    keys.map(async (k) => {
      modelsByKeyId[k.id] = await fetchModelList(ctx, k.id, orgId).catch(
        () => [] as AiProviderModel[],
      );
    }),
  );

  const sdkKeys: AiProviderKey[] = keys.map((k) => ({
    id: k.id,
    providerId: k.providerId,
    label: k.label,
    presetId: k.presetId,
    createdBy: k.createdBy,
    createdAt: k.createdAt,
  }));
  const defaults = pickSimpleModeDefaults(sdkKeys, modelsByKeyId);
  const picked = pickSlotForTier(tier, defaults);
  if (!picked) throw new TierUnavailableError(tier);

  return {
    credentialId: picked.keyId,
    modelId: picked.modelId,
    modelMeta: metaFromCatalogEntry(
      modelsByKeyId[picked.keyId] ?? [],
      picked.modelId,
      picked.title,
    ),
  };
}

/**
 * Resolve a concrete (credentialId, modelId) pair into a ResolvedTier,
 * enriching it with catalog metadata when available. Used by automations that
 * pin a specific model instead of an org tier preset. Unlike `resolveTier`
 * this never consults org settings or default-picks — the caller has already
 * chosen the exact model + credential. The credential must still exist and
 * belong to a hosted provider; native coding agents cannot run automations.
 */
export async function resolveSpecificModel(
  ctx: StudioContext,
  credentialId: string,
  modelId: string,
): Promise<ResolvedTier> {
  const orgId = ctx.organization?.id;
  if (!orgId) {
    throw new Error("resolveSpecificModel called without an organization");
  }

  const key = await ctx.storage.aiProviderKeys
    .findById(credentialId, orgId)
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === "Provider key not found"
      ) {
        throw new SpecificModelCredentialUnavailableError(
          `AI provider credential "${credentialId}" was not found`,
          { cause: error },
        );
      }
      throw error;
    });
  if (!isHostedProviderId(key.providerId)) {
    throw new SpecificModelCredentialUnavailableError(
      `AI provider credential "${credentialId}" uses native-only provider "${key.providerId}" and cannot run a hosted model`,
    );
  }

  const catalog = await fetchModelList(ctx, credentialId, orgId).catch(
    () => [] as AiProviderModel[],
  );
  return {
    credentialId,
    modelId,
    modelMeta: metaFromCatalogEntry(catalog, modelId),
  };
}

export async function tryResolveTier(
  ctx: StudioContext,
  tier: SimpleModeTier,
): Promise<ResolvedTier | null> {
  try {
    return await resolveTier(ctx, tier);
  } catch (err) {
    if (err instanceof TierUnavailableError) return null;
    console.warn(`[resolveTier] tier "${tier}" resolution failed:`, err);
    return null;
  }
}
