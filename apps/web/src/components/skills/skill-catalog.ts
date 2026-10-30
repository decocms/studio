/**
 * How the catalog reads to a person: display names, the source a skill came
 * from, its category and the packages built from it. Pure, so the picker and
 * Settings → Skills group the same catalog the same way.
 */

import {
  SKILL_BUNDLES,
  SKILL_CATEGORY_IDS,
  bundleIdOfRef,
  isSkillCategory,
  type SkillBundleId,
  type SkillCategoryId,
} from "@decocms/shared/skills";
import type { OrgFsSkillCatalogEntry } from "@/hooks/use-org-fs";
import type { TFunction } from "@/i18n/use-t";

/** `deco-edge-caching` → `Deco edge caching`, for skills without a `title`. */
function humanize(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function skillDisplayName(skill: OrgFsSkillCatalogEntry): string {
  return skill.title || humanize(skill.name);
}

/** `public:core` → `core`, `repo:<volume>` → `<volume>`, `home` → `null`. */
export function skillSourceLabel(source: string): string | null {
  if (source === "home") return null;
  const i = source.indexOf(":");
  return i === -1 ? source : source.slice(i + 1);
}

export type CategoryKey = SkillCategoryId | "other";

export function categoryOf(skill: OrgFsSkillCatalogEntry): CategoryKey {
  return isSkillCategory(skill.category) ? skill.category : "other";
}

export function categoryLabel(t: TFunction, key: CategoryKey): string {
  return t(`skills.category.${key}`);
}

/** Skills grouped by category, in taxonomy order, "other" last. */
export function groupByCategory(
  skills: OrgFsSkillCatalogEntry[],
): Array<{ key: CategoryKey; skills: OrgFsSkillCatalogEntry[] }> {
  const order: CategoryKey[] = [...SKILL_CATEGORY_IDS, "other"];
  return order
    .map((key) => ({
      key,
      skills: skills
        .filter((s) => categoryOf(s) === key)
        .toSorted((a, b) =>
          skillDisplayName(a).localeCompare(skillDisplayName(b)),
        ),
    }))
    .filter((g) => g.skills.length > 0);
}

export interface BundleSummary {
  id: SkillBundleId;
  category: SkillCategoryId;
  title: string;
  description: string;
  /** Members a run can load — what picking the bundle brings in today. */
  members: OrgFsSkillCatalogEntry[];
}

export function bundleSummaries(
  t: TFunction,
  catalog: OrgFsSkillCatalogEntry[],
): BundleSummary[] {
  return SKILL_BUNDLES.map((b) => ({
    id: b.id,
    category: b.category,
    title: t(`skills.bundle.${b.id}`),
    description: t(`skills.bundle.${b.id}.description`),
    members: catalog.filter(
      (s) => !s.disableModelInvocation && s.bundles?.includes(b.id),
    ),
  }));
}

/** A stored reference as people read it: its name and, for a package, its
 *  members. `missing` when the catalog no longer has it. */
export interface ResolvedRef {
  ref: string;
  name: string;
  bundle: BundleSummary | null;
  missing: boolean;
}

export function resolveRef(
  ref: string,
  catalog: OrgFsSkillCatalogEntry[],
  bundles: BundleSummary[],
): ResolvedRef {
  const bundleId = bundleIdOfRef(ref);
  if (bundleId !== null) {
    const bundle = bundles.find((b) => b.id === bundleId) ?? null;
    return { ref, name: bundle?.title ?? bundleId, bundle, missing: !bundle };
  }
  const skill = catalog.find((s) => s.id === ref);
  return {
    ref,
    name: skill ? skillDisplayName(skill) : ref,
    bundle: null,
    missing: !skill,
  };
}
