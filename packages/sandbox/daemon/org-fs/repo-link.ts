/**
 * Makes the org filesystem reachable from the agent's working directory.
 *
 * Harness shells run with cwd `<appRoot>/repo`, but the volumes mount at
 * `<appRoot>/org` — so the prompts' relative `org/...` paths wouldn't
 * resolve. This drops a relative symlink `<repoDir>/org → ../org` at
 * dispatch time (post-clone — a boot-time link would make `git clone`
 * refuse the non-empty dir) and registers it in `.git/info/exclude` so the
 * daemon's shutdown `git add -A` never commits it to user branches
 * (info/exclude is local-only, unlike .gitignore). Never throws.
 */

import { appendFile, lstat, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

const EXCLUDE_LINE = "/org";

export async function ensureRepoOrgLink(
  repoDir: string,
  log: (msg: string, err?: unknown) => void = () => {},
): Promise<void> {
  try {
    const link = join(repoDir, "org");
    const cur = await lstat(link).catch(() => null);
    if (cur) {
      if (!cur.isSymbolicLink()) {
        // A real `org/` tracked by the repo wins; never shadow user content.
        return;
      }
    } else {
      await symlink("../org", link);
    }
    // Keep the link out of version control (no-op without a .git dir).
    const excludePath = join(repoDir, ".git", "info", "exclude");
    const existing = await readFile(excludePath, "utf8").catch(() => null);
    if (existing !== null && !existing.split("\n").includes(EXCLUDE_LINE)) {
      await appendFile(excludePath, `${EXCLUDE_LINE}\n`);
    }
  } catch (err) {
    log("repo org link failed", err);
  }
}
