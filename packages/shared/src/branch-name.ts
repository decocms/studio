/**
 * Branch-name generator used as a fallback when SANDBOX_START is invoked without
 * an explicit branch. Lives in shared/ because it runs on both sides: the web
 * "New branch" button calls it in the browser, while the orchestrator calls it
 * server-side so it — not the sandbox — decides the branch name and can persist
 * it to sandboxMap before the daemon ever sees it.
 *
 * Format: `<user-slug>-<base36-timestamp>` (e.g. `joao-silva-mabc1x9z`). The
 * slug attributes the branch to whoever created it; the base36-encoded
 * `Date.now()` is a monotonic clock, so a given user only collides if two
 * branches are minted within the same millisecond. The suffix is always a valid
 * git ref token (lowercase alphanumeric).
 */

/**
 * Slugify an arbitrary label (display name, email local-part, …) into a git-ref
 * safe token: strip diacritics, lowercase, collapse every run of non
 * alphanumeric characters to a single hyphen, and trim leading/trailing
 * hyphens. Returns "user" when nothing usable remains.
 */
function slugify(label: string | null | undefined): string {
  const slug = (label ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "user";
}

/**
 * Build a branch name for `userLabel` (the creator's display name, or their
 * email local-part as a fallback). Callers should pass the most human-readable
 * identity they have; slugification handles the rest.
 */
export function generateBranchName(userLabel?: string | null): string {
  const slug = slugify(userLabel);
  // base36(Date.now()) is a clock: its high-order (leading) digits change
  // slowly, so branches minted the same day share a prefix like "mrch3…".
  // Reverse the digits so the fast-changing low-order digit leads and the
  // suffix looks distinct at a glance. Reversal is a bijection, so this keeps
  // the exact same uniqueness guarantee (two branches only collide if minted
  // within the same millisecond).
  const stamp = Date.now().toString(36).split("").reverse().join("");
  return `${slug}-${stamp}`;
}
