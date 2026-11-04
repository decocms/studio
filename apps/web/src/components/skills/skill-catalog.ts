/** How the catalog reads to a person: display names, categories and the bundles built from it. */

import {
  SKILL_BUNDLES,
  isSkillCategory,
  type SkillBundleId,
  type SkillCategoryId,
} from "./skills-mock";
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

export type CategoryKey = SkillCategoryId | "other";

export function categoryOf(skill: OrgFsSkillCatalogEntry): CategoryKey {
  return isSkillCategory(skill.category) ? skill.category : "other";
}

export function categoryLabel(t: TFunction, key: CategoryKey): string {
  return t(`skills.category.${key}`);
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
