import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveRemoteDefaultBranch } from "./checkout-branch";

// The protected branch list is a plain data file, not interpolated into the
// script, so an unusual (but valid) ref name can't inject shell syntax here.
const HOOK = `#!/bin/sh
protected="$(dirname "$0")/protected-branches"
while IFS=' ' read -r _local_ref _local_sha remote_ref _remote_sha; do
  branch="\${remote_ref#refs/heads/}"
  if grep -qxF "$branch" "$protected" 2>/dev/null; then
    echo "error: pushing to '$branch' is not allowed from a sandbox" >&2
    exit 1
  fi
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
  await writeFile(join(hooksDir, "pre-push"), HOOK, { encoding: "utf-8" });
  await chmod(join(hooksDir, "pre-push"), 0o755);

  // Not every repo names its default branch main/master (trunk, develop,
  // etc.) — protect the repo's actual default too, or a sandbox push would
  // sail straight through on those repos.
  const branches = new Set([
    "main",
    "master",
    resolveRemoteDefaultBranch(repoDir),
  ]);
  await writeFile(
    join(hooksDir, "protected-branches"),
    `${[...branches].join("\n")}\n`,
    { encoding: "utf-8" },
  );
}
