import type { Release } from "@decocms/shared/sdk/types";
import type { TFunction } from "@/i18n/use-t.ts";

/**
 * Base name for a new draft: "{first name}'s draft" when the creator is known,
 * so a switcher shared by the whole team shows whose draft is whose; plain
 * "Draft" otherwise. `userLabel` is a `branchUserLabel` value (display name, or
 * email local-part).
 */
export function draftBaseName(
  t: TFunction,
  userLabel: string | null | undefined,
): string {
  const firstName = userLabel?.trim().split(/\s+/)[0];
  return firstName
    ? t("thread.branchPicker.userDraftName", { name: firstName })
    : t("thread.branchPicker.defaultVersionName");
}

/**
 * Next auto name for an unnamed draft: `base` itself while no draft uses it,
 * then one above the highest "`{base}` N", with a bare `base` counting as 1
 * ("Ana's draft" → "Ana's draft 2"). Renamed releases don't count. Shared so
 * the branch picker and the "start a new draft" CTAs number drafts identically.
 */
export function nextDraftName(releases: Release[], base: string): string {
  const prefix = `${base} `;
  const max = releases.reduce((m, r) => {
    if (r.name === base) return Math.max(m, 1);
    if (!r.name.startsWith(prefix)) return m;
    const n = Number(r.name.slice(prefix.length));
    return Number.isInteger(n) && n > m ? n : m;
  }, 0);
  return max === 0 ? base : `${base} ${max + 1}`;
}
