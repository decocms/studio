/**
 * The vocabulary people pick skills by. A SKILL.md names its `category` and
 * `bundles` in frontmatter; the ids live here so every repo that syncs into
 * Studio, the catalog, and the pickers agree on them. Labels are the web
 * app's job (i18n), keyed by these ids.
 */

export const SKILL_CATEGORY_IDS = [
  "storefront",
  "performance",
  "seo",
  "analytics",
  "migration",
  "quality",
  "delivery",
  "content",
  "platform",
] as const;

export type SkillCategoryId = (typeof SKILL_CATEGORY_IDS)[number];

export function isSkillCategory(
  value: string | undefined | null,
): value is SkillCategoryId {
  return SKILL_CATEGORY_IDS.some((id) => id === value);
}

/**
 * Packages of skills that do one job together. Members join by listing the
 * bundle in their own frontmatter, so a skill added to a repo lands in every
 * rule that already picked its bundle on the next sync.
 */
export const SKILL_BUNDLES = [
  { id: "pr-qa", category: "quality" },
  { id: "pr-review", category: "delivery" },
  { id: "storefront-building", category: "storefront" },
  { id: "storefront-performance", category: "performance" },
  { id: "caching", category: "performance" },
  { id: "seo-audit", category: "seo" },
  { id: "store-diagnostic", category: "analytics" },
  { id: "conversion-analysis", category: "analytics" },
  { id: "migration-tanstack", category: "migration" },
  { id: "migration-faststore", category: "migration" },
  { id: "go-live", category: "quality" },
  { id: "jira-workflow", category: "delivery" },
  { id: "office-documents", category: "content" },
  { id: "presentations", category: "content" },
  { id: "writing", category: "content" },
  { id: "security-audit", category: "quality" },
  { id: "mcp-apps", category: "platform" },
] as const satisfies ReadonlyArray<{ id: string; category: SkillCategoryId }>;

export type SkillBundleId = (typeof SKILL_BUNDLES)[number]["id"];

export function isSkillBundle(value: string): value is SkillBundleId {
  return SKILL_BUNDLES.some((b) => b.id === value);
}

/**
 * A rule or automation stores skill references: a catalog id
 * (`core/qa-screenshot`) or a whole bundle (`bundle:pr-qa`).
 */
const BUNDLE_REF_PREFIX = "bundle:";

export function bundleRef(id: SkillBundleId): string {
  return `${BUNDLE_REF_PREFIX}${id}`;
}

/** The bundle id a reference names, or null for a plain skill id. */
export function bundleIdOfRef(ref: string): string | null {
  return ref.startsWith(BUNDLE_REF_PREFIX)
    ? ref.slice(BUNDLE_REF_PREFIX.length)
    : null;
}

interface CatalogSkill {
  id: string;
  bundles?: readonly string[];
  disableModelInvocation: boolean;
}

/**
 * The catalog ids a set of references loads: plain ids as given, bundles as
 * their current members a run can load. Order-stable and deduplicated.
 */
export function expandSkillRefs(
  refs: readonly string[],
  catalog: readonly CatalogSkill[],
): string[] {
  const out = new Set<string>();
  for (const ref of refs) {
    const bundle = bundleIdOfRef(ref);
    if (bundle === null) {
      out.add(ref);
      continue;
    }
    for (const skill of catalog) {
      if (!skill.disableModelInvocation && skill.bundles?.includes(bundle)) {
        out.add(skill.id);
      }
    }
  }
  return [...out];
}

/**
 * Why references can't be saved, or null. Checked against the catalog so a
 * rule never looks configured with something no run can load.
 */
export function invalidSkillRefs(
  refs: readonly string[],
  catalog: readonly CatalogSkill[],
): string | null {
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const unknown: string[] = [];
  const manual: string[] = [];
  for (const ref of refs) {
    const bundle = bundleIdOfRef(ref);
    if (bundle !== null) {
      if (!isSkillBundle(bundle)) unknown.push(ref);
      continue;
    }
    const skill = byId.get(ref);
    if (!skill) unknown.push(ref);
    else if (skill.disableModelInvocation) manual.push(ref);
  }
  if (unknown.length > 0) return `Unknown skill(s): ${unknown.join(", ")}`;
  if (manual.length > 0) {
    return `Manual-only skill(s) a run can't load: ${manual.join(", ")}`;
  }
  return null;
}

/** The line that asks a run to load its configured skills. */
export function skillsLoadLine(ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined;
  return `Skills configured for this work — load each one with the skill tool before you start: ${ids.join(", ")}`;
}
