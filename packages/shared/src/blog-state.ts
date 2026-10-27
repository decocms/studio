/**
 * What both sides of the blog's editorial state have to agree on.
 *
 * The state itself lives in the organization's file library, read and written
 * through `BLOG_STATE_GET` / `BLOG_STATE_SET`. Those travel over REST, where an
 * error is a message — so the one thing the CMS must be able to recognize in it
 * gets a name here rather than a string literal on each side.
 */

/**
 * Prefix on the error a refused write produces.
 *
 * A write is refused when the file changed since the version the edit started
 * from. That is the normal outcome of two people — or a person and a run —
 * editing the same brand profile, and the CMS offers a choice rather than an
 * error. Anything without this prefix is storage genuinely failing.
 */
export const BLOG_STATE_CONFLICT = "blog-state-conflict:";

/** Whether a thrown value is a refused write rather than a broken one. */
export function isBlogStateConflict(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(BLOG_STATE_CONFLICT);
}
