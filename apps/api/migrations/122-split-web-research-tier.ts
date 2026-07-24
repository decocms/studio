import { type Kysely } from "kysely";

/**
 * Split the single `web_research` model tier into two: `web_search` (quick,
 * streaming — e.g. Perplexity Sonar) and `deep_research` (slow, multi-source —
 * e.g. Perplexity deep-research or Gemini Deep Research async).
 *
 * The split is **capability-aware**, not a blind copy-into-both. Copying a
 * deep/async model into the quick `web_search` slot would make every quick
 * lookup launch a slow research job — the exact UX this feature removes. At
 * migration time there is no model catalog (mirrors migration 077), so we
 * classify by the stored `modelId` string:
 *
 *   - id reads "deep research"  → goes to `deep_research`; `web_search` left
 *     null so runtime `resolveTier` falls back to the curated quick default.
 *   - anything else (sonar/…)    → goes to `web_search`; `deep_research` left
 *     null so runtime falls back to the curated deep default.
 *
 * Idempotent: rows already carrying `web_search`/`deep_research` tier keys are
 * skipped. The legacy `web_research` key is dropped.
 */

type Slot = { keyId: string; modelId: string; title?: string } | null;

interface TiersShape {
  fast?: Slot;
  smart?: Slot;
  thinking?: Slot;
  image?: Slot;
  web_research?: Slot;
  web_search?: Slot;
  deep_research?: Slot;
}

interface SimpleModeShape {
  tiers?: TiersShape | null;
}

function isDeepResearchModelId(modelId: string): boolean {
  return modelId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .includes("deepresearch");
}

function isAlreadySplit(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const tiers = (value as SimpleModeShape).tiers;
  if (!tiers || typeof tiers !== "object") return false;
  return "web_search" in tiers || "deep_research" in tiers;
}

export function splitWebResearchTier(
  simpleMode: SimpleModeShape | null,
): SimpleModeShape | null {
  if (!simpleMode || isAlreadySplit(simpleMode)) return simpleMode;
  const tiers: TiersShape = simpleMode.tiers ?? {};
  const legacy = tiers.web_research ?? null;
  const { web_research: _drop, ...rest } = tiers;

  let webSearch: Slot = null;
  let deepResearch: Slot = null;
  if (legacy) {
    if (isDeepResearchModelId(legacy.modelId)) {
      deepResearch = legacy;
    } else {
      webSearch = legacy;
    }
  }

  return {
    ...simpleMode,
    tiers: {
      ...rest,
      web_search: webSearch,
      deep_research: deepResearch,
    },
  };
}

export const __testing = { splitWebResearchTier, isAlreadySplit };

export async function up(db: Kysely<unknown>): Promise<void> {
  // organization_settings uses camelCase `organizationId` (migration 002).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (db as any)
    .selectFrom("organization_settings")
    .select(["organizationId", "simple_mode"])
    .execute();

  for (const row of rows) {
    if (!row.simple_mode) continue;
    const parsed: SimpleModeShape | null =
      typeof row.simple_mode === "string"
        ? JSON.parse(row.simple_mode)
        : row.simple_mode;
    if (isAlreadySplit(parsed)) continue;
    const next = splitWebResearchTier(parsed);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .updateTable("organization_settings")
      .set({ simple_mode: JSON.stringify(next) })
      .where("organizationId", "=", row.organizationId)
      .execute();
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  throw new Error(
    "122-split-web-research-tier is not reversible. Restore from snapshot.",
  );
}
