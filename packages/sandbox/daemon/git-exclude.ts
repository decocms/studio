import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/**
 * Registers `line` in `<repoDir>/.git/info/exclude` so the daemon's shutdown
 * `git add -A` never commits daemon-managed paths onto user branches.
 * info/exclude is local-only (unlike .gitignore), so it never leaks into the
 * repo. No-op without a `.git` dir — the caller re-runs on every tool call, so
 * the line lands once one exists. Never throws (best-effort).
 */
export async function ensureGitExclude(
  repoDir: string,
  line: string,
): Promise<void> {
  try {
    const gitDir = join(repoDir, ".git");
    const gitStat = await lstat(gitDir).catch(() => null);
    if (!gitStat?.isDirectory()) return;
    const excludePath = join(gitDir, "info", "exclude");
    const existing = await readFile(excludePath, "utf8").catch(() => null);
    if (existing === null) {
      // Template-less clones (libgit2/JGit, bare templates) lack info/exclude.
      await mkdir(join(gitDir, "info"), { recursive: true });
      await writeFile(excludePath, `${line}\n`);
    } else if (!existing.split("\n").includes(line)) {
      await appendFile(excludePath, `${line}\n`);
    }
  } catch {
    // Best-effort: an unwritable .git never blocks the caller.
  }
}
