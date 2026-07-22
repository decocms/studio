import type { TFunction } from "@/web/i18n/use-t.ts";

const PRODUCTION_BASE_BRANCHES = new Set(["main", "master"]);

/** Squash-merge / publish action label for a target base branch. */
export function publishToBaseLabel(base: string, t: TFunction): string {
  return PRODUCTION_BASE_BRANCHES.has(base.trim().toLowerCase())
    ? t("thread.headerActions.publishToProduction")
    : t("thread.headerActions.publish");
}
