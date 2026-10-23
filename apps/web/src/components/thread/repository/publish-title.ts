/**
 * Only these bases are production; publishing elsewhere is not "in
 * production". A Blocks v8 site's button never says it (see `publishTitle`).
 */
function isProductionBranch(base: string): boolean {
  return ["main", "master"].includes(base.trim().toLowerCase());
}

/**
 * The Publish button's label: "Publish N changes", and on a v7 site
 * publishing to main or master "Publish N changes in production", as before.
 */
export function publishTitle(
  count: number,
  baseBranch: string,
  v8: boolean,
  t: (key: PublishTitleKey, vars?: { count: number }) => string,
): string {
  if (count === 0) return t("thread.publishPopover.publish");
  if (v8 || !isProductionBranch(baseBranch)) {
    return count === 1
      ? t("thread.publishPopover.publishOne")
      : t("thread.publishPopover.publishCount", { count });
  }
  return count === 1
    ? t("thread.publishPopover.publishOneInProduction")
    : t("thread.publishPopover.publishCountInProduction", { count });
}

type PublishTitleKey =
  | "thread.publishPopover.publish"
  | "thread.publishPopover.publishOne"
  | "thread.publishPopover.publishCount"
  | "thread.publishPopover.publishOneInProduction"
  | "thread.publishPopover.publishCountInProduction";
