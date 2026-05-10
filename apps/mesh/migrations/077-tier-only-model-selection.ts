import { type Kysely } from "kysely";
import type { SimpleModeTier } from "../src/tools/organization/schema";

type LegacySlot = { keyId: string; modelId: string; title?: string };

interface LegacySimpleMode {
  enabled?: boolean;
  chat?: {
    fast?: LegacySlot | null;
    smart?: LegacySlot | null;
    thinking?: LegacySlot | null;
  } | null;
  image?: LegacySlot | null;
  webResearch?: LegacySlot | null;
}

interface NewSimpleMode {
  tiers: Record<SimpleModeTier, LegacySlot | null>;
}

const EMPTY_TIERS: NewSimpleMode = {
  tiers: {
    fast: null,
    smart: null,
    thinking: null,
    image: null,
    web_research: null,
  },
};

export function reshapeSimpleMode(
  legacy: LegacySimpleMode | null,
): NewSimpleMode {
  const enabled = legacy?.enabled === true;
  const slot = (s: LegacySlot | null | undefined): LegacySlot | null =>
    s && s.keyId && s.modelId
      ? { keyId: s.keyId, modelId: s.modelId, title: s.title }
      : null;

  if (!enabled) {
    // Disabled or null legacy config: leave tiers null. Runtime resolveTier()
    // falls back to the SDK's pickSimpleModeDefaults using the org's actual
    // connected providers + model catalogs, matching the settings page UX.
    return EMPTY_TIERS;
  }

  return {
    tiers: {
      fast: slot(legacy?.chat?.fast),
      smart: slot(legacy?.chat?.smart),
      thinking: slot(legacy?.chat?.thinking),
      image: slot(legacy?.image),
      web_research: slot(legacy?.webResearch),
    },
  };
}

interface ModelMetaForHeuristic {
  modelId: string;
  capabilities: string[];
  limits: unknown;
  priceUsdPerMillionOutputTokens?: number | null;
}

interface LegacyAutomationModels {
  tier?: SimpleModeTier;
  credentialId?: string;
  thinking?: {
    id?: string;
    capabilities?: { reasoning?: boolean; text?: boolean; image?: boolean };
  };
}

export function inferAutomationTier(
  models: LegacyAutomationModels,
  catalog: ModelMetaForHeuristic[],
): "fast" | "smart" | "thinking" {
  if (
    models.tier === "fast" ||
    models.tier === "smart" ||
    models.tier === "thinking"
  ) {
    return models.tier;
  }
  const id = models.thinking?.id;
  if (!id) return "smart";

  const meta = catalog.find((m) => m.modelId === id);
  const reasoning =
    meta?.capabilities?.includes("reasoning") ??
    models.thinking?.capabilities?.reasoning === true;
  if (reasoning) return "thinking";

  const priced = catalog
    .map((m) => m.priceUsdPerMillionOutputTokens)
    .filter((p): p is number => typeof p === "number" && p > 0)
    .sort((a, b) => a - b);
  const myPrice = meta?.priceUsdPerMillionOutputTokens;
  if (priced.length >= 3 && typeof myPrice === "number") {
    const lowestThirdCutoff = priced[Math.floor(priced.length / 3) - 1] ?? 0;
    if (myPrice <= lowestThirdCutoff) return "fast";
  }
  return "smart";
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Reshape organization_settings.simple_mode
  // Note: organization_settings uses camelCase `organizationId` (migration 002).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orgs = await (db as any)
    .selectFrom("organization_settings")
    .select(["organizationId", "simple_mode"])
    .execute();

  for (const row of orgs) {
    const legacy = row.simple_mode
      ? ((typeof row.simple_mode === "string"
          ? JSON.parse(row.simple_mode)
          : row.simple_mode) as LegacySimpleMode)
      : null;
    const reshaped = reshapeSimpleMode(legacy);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .updateTable("organization_settings")
      .set({ simple_mode: JSON.stringify(reshaped) })
      .where("organizationId", "=", row.organizationId)
      .execute();
  }

  // 2. Reshape automations.models — collapse to { tier }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const automations = await (db as any)
    .selectFrom("automations")
    .select(["id", "organization_id", "models"])
    .execute();

  for (const automation of automations) {
    let legacyModels: LegacyAutomationModels;
    try {
      legacyModels =
        typeof automation.models === "string"
          ? JSON.parse(automation.models)
          : automation.models;
    } catch {
      legacyModels = {};
    }
    const tier = inferAutomationTier(legacyModels, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .updateTable("automations")
      .set({ models: JSON.stringify({ tier }) })
      .where("id", "=", automation.id)
      .execute();
    if (legacyModels.thinking?.capabilities?.image) {
      console.log(
        `[migration 077] automation ${automation.id} previously used an image-only model; mapped to "${tier}"`,
      );
    }
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  throw new Error(
    "077-tier-only-model-selection is not reversible. Restore from snapshot.",
  );
}
