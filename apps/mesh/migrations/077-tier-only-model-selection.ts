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

const TIER_KEYS: SimpleModeTier[] = [
  "fast",
  "smart",
  "thinking",
  "image",
  "web_research",
];

function isAlreadyReshapedSimpleMode(value: unknown): value is NewSimpleMode {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!("tiers" in obj)) return false;
  const tiers = obj.tiers;
  if (!tiers || typeof tiers !== "object") return false;
  // At least one of the known tier keys is present.
  return TIER_KEYS.some((k) => k in (tiers as Record<string, unknown>));
}

export function reshapeSimpleMode(
  legacy: LegacySimpleMode | NewSimpleMode | null,
): NewSimpleMode {
  // Idempotency: if the input is already in the new shape (has a `tiers`
  // object with any of the known tier keys), return it unchanged.
  if (isAlreadyReshapedSimpleMode(legacy)) {
    return legacy;
  }

  const legacyConfig = legacy as LegacySimpleMode | null;
  const enabled = legacyConfig?.enabled === true;
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
      fast: slot(legacyConfig?.chat?.fast),
      smart: slot(legacyConfig?.chat?.smart),
      thinking: slot(legacyConfig?.chat?.thinking),
      image: slot(legacyConfig?.image),
      web_research: slot(legacyConfig?.webResearch),
    },
  };
}

interface LegacyAutomationModels {
  tier?: SimpleModeTier;
  credentialId?: string;
  thinking?: {
    id?: string;
    capabilities?: { reasoning?: boolean; text?: boolean; image?: boolean };
  };
  coding?: unknown;
  fast?: unknown;
  smart?: unknown;
}

export function inferAutomationTier(
  models: LegacyAutomationModels,
): "fast" | "smart" | "thinking" {
  if (
    models.tier === "fast" ||
    models.tier === "smart" ||
    models.tier === "thinking"
  ) {
    return models.tier;
  }
  // Reasoning capability stored on the legacy `thinking` model object is the
  // only signal we have here — there is no model catalog available at
  // migration time, so we can't honestly do a price-based heuristic.
  if (models.thinking?.capabilities?.reasoning === true) {
    return "thinking";
  }
  return "smart";
}

/**
 * Returns true if `models` is already in the new `{ tier }` shape — i.e. has
 * a valid `tier` field and none of the legacy keys (`credentialId`,
 * `thinking`, `coding`, `fast`, `smart`).
 */
function isAlreadyReshapedAutomationModels(
  models: LegacyAutomationModels,
): boolean {
  const validTier =
    models.tier === "fast" ||
    models.tier === "smart" ||
    models.tier === "thinking";
  if (!validTier) return false;
  const legacyKeys: (keyof LegacyAutomationModels)[] = [
    "credentialId",
    "thinking",
    "coding",
    "fast",
    "smart",
  ];
  return legacyKeys.every((k) => models[k] === undefined);
}

export const __testing = {
  isAlreadyReshapedSimpleMode,
  isAlreadyReshapedAutomationModels,
};

export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's migrator already wraps each migration in a transaction, so all
  // updates below run atomically without an explicit `db.transaction()`
  // wrapper (which would error: nested transactions are not supported).

  // 1. Reshape organization_settings.simple_mode
  // Note: organization_settings uses camelCase `organizationId` (migration 002).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orgs = await (db as any)
    .selectFrom("organization_settings")
    .select(["organizationId", "simple_mode"])
    .execute();

  for (const row of orgs) {
    const parsed = row.simple_mode
      ? typeof row.simple_mode === "string"
        ? JSON.parse(row.simple_mode)
        : row.simple_mode
      : null;
    // Skip already-migrated rows.
    if (isAlreadyReshapedSimpleMode(parsed)) {
      continue;
    }
    const reshaped = reshapeSimpleMode(parsed as LegacySimpleMode | null);
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
    // Skip rows that are already in the new `{ tier }` shape.
    if (isAlreadyReshapedAutomationModels(legacyModels)) {
      continue;
    }
    const tier = inferAutomationTier(legacyModels);
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
