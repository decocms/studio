import type { StudioContext } from "@/core/studio-context";
import type { SimpleModeTier } from "@/tools/organization/schema";
import {
  pickSimpleModeDefaults,
  type AiProviderKey,
  type AiProviderModel,
  type SimpleModeDefaults,
  type SimpleModeModelSlot,
} from "@decocms/mesh-sdk";

export class TierUnavailableError extends Error {
  constructor(public tier: SimpleModeTier) {
    super(
      `No model available for tier "${tier}". Connect a provider or configure the tier in organization settings.`,
    );
    this.name = "TierUnavailableError";
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
    case "web_research":
      return defaults.webResearch;
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
): Promise<ResolvedTier> {
  const orgId = ctx.organization?.id;
  if (!orgId) throw new Error("resolveTier called without an organization");

  const settings = await ctx.storage.organizationSettings.get(orgId);
  const slot = settings?.simple_mode?.tiers?.[tier] ?? null;

  const keys = await ctx.storage.aiProviderKeys.list({ organizationId: orgId });

  // Fast path: admin has explicitly assigned this tier slot AND the key still
  // exists. If the key was deleted but the slot wasn't cleared, fall through
  // to the default-pick rather than returning a stale credentialId.
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
