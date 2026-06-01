const PRODUCTION_BASE_BRANCHES = new Set(["main", "master"]);

/** Squash-merge / publish action label for a target base branch. */
export function publishToBaseLabel(base: string): string {
  return PRODUCTION_BASE_BRANCHES.has(base.trim().toLowerCase())
    ? "Publish to production"
    : "Publish";
}
