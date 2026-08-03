/**
 * Branch-name generator used as a fallback when SANDBOX_START is invoked without
 * an explicit branch. Lives in shared/ because it runs on both sides: the web
 * "New branch" button calls it in the browser, while the orchestrator calls it
 * server-side so it — not the sandbox — decides the branch name and can persist
 * it to sandboxMap before the daemon ever sees it.
 *
 * Format: `<user-slug>-<reversed-base36-timestamp>` (e.g. `joao-silva-z9x1cbam`).
 * The slug attributes the branch to whoever created it; the base36-encoded
 * `Date.now()` is a monotonic clock, so a given user only collides if two
 * branches are minted within the same millisecond. The suffix is always a valid
 * git ref token (lowercase alphanumeric).
 *
 * Every call mints a NEW identity — a new branch, and therefore a new sandbox.
 * Two callers racing to name the same logical thing produce two sandboxes
 * (sibling names 8ms apart, one of them orphaned). Only call this where a fresh
 * branch is the intent; anywhere else, pass the branch you already have.
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
 * The label to hand `generateBranchName` for a user: their display name, or
 * their email local-part when there's no usable name.
 *
 * Use this instead of writing `user?.name ?? user?.email?.split("@")[0]` at the
 * call site. `??` is wrong there: Better Auth stores an unset display name as
 * `""`, which is not nullish, so `??` returns the empty string, never reaches
 * the email, and `slugify` falls back to the literal `"user"`. Every branch for
 * such a user was named `user-<stamp>` — 171 prod threads before this existed.
 * `||` skips the empty string.
 *
 * Returns `undefined` (not `""`) when neither field is usable, so
 * `generateBranchName`'s own fallback stays the single place that decides what
 * an unidentifiable user's branch looks like.
 */
export function branchUserLabel(
  user: { name?: string | null; email?: string | null } | null | undefined,
): string | undefined {
  return user?.name || user?.email?.split("@")[0] || undefined;
}

/**
 * Build a branch name for `userLabel` (the creator's display name, or their
 * email local-part as a fallback — see `branchUserLabel`). Callers should pass
 * the most human-readable identity they have; slugification handles the rest.
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
