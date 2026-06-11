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

import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
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
    // Keep the link out of version control (no-op without a .git dir — the
    // hook re-runs on every tool call, so the exclude lands once one exists).
    const gitDir = join(repoDir, ".git");
    const gitStat = await lstat(gitDir).catch(() => null);
    if (!gitStat?.isDirectory()) return;
    const excludePath = join(gitDir, "info", "exclude");
    const existing = await readFile(excludePath, "utf8").catch(() => null);
    if (existing === null) {
      // Template-less clones (libgit2/JGit, bare templates) lack
      // info/exclude; without it the shutdown `git add -A` would commit the
      // link onto the user's branch.
      await mkdir(join(gitDir, "info"), { recursive: true });
      await writeFile(excludePath, `${EXCLUDE_LINE}\n`);
    } else if (!existing.split("\n").includes(EXCLUDE_LINE)) {
      await appendFile(excludePath, `${EXCLUDE_LINE}\n`);
    }
  } catch (err) {
    log("repo org link failed", err);
  }
}
