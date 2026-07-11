import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HOOK = `#!/bin/sh
while IFS=' ' read -r _local_ref _local_sha remote_ref _remote_sha; do
  branch="\${remote_ref#refs/heads/}"
  case "$branch" in
    main|master)
      echo "error: pushing to '$branch' is not allowed from a sandbox" >&2
      exit 1
      ;;
  esac
done
exit 0
`;

// Sync fs here would block the daemon's single event loop long enough to
// miss a health probe (CONTRIBUTING.md rule #4) — use the async variants.
export async function installProtectedBranchHook(
  repoDir: string,
): Promise<void> {
  const hooksDir = join(repoDir, ".git", "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-push");
  await writeFile(hookPath, HOOK, { encoding: "utf-8" });
  await chmod(hookPath, 0o755);
}
