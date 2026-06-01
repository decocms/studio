/** Squash-merge / publish action label for a target base branch. */
export function publishToBaseLabel(base: string): string {
  return base.trim().toLowerCase() === "main"
    ? "Publish to production"
    : "Publish";
}
