/**
 * How the copy says where a test or campaign is used: pages and sections
 * counted apart ("2 pages and 1 section"), never sections counted as pages.
 * The Delete toast and the Publish review's A/B tests and Campaigns cards
 * share it.
 */

import type { TFunction } from "@/i18n/use-t.ts";
import type { NamedRuleUseCounts } from "./named-rule-uses";

/** "1 page", "3 sections", "2 pages and 1 section"; `null` for none. */
export function namedRuleUsePlaces(
  t: TFunction,
  counts: NamedRuleUseCounts,
): { places: string; one: boolean } | null {
  const pages =
    counts.pages === 1
      ? t("sectionsEditor.namedRuleUses.countPageOne")
      : counts.pages > 1
        ? t("sectionsEditor.namedRuleUses.countPages", {
            count: String(counts.pages),
          })
        : null;
  const sections =
    counts.sections === 1
      ? t("sectionsEditor.namedRuleUses.countSectionOne")
      : counts.sections > 1
        ? t("sectionsEditor.namedRuleUses.countSections", {
            count: String(counts.sections),
          })
        : null;
  const places =
    pages && sections
      ? t("sectionsEditor.namedRuleUses.countBoth", { pages, sections })
      : (pages ?? sections);
  if (!places) return null;
  return { places, one: counts.pages + counts.sections === 1 };
}
