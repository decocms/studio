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

// Branches a sandbox must never push to directly. Not every repo names its
// default branch main/master (trunk, develop, etc.) — protect the repo's actual
// default too, or a sandbox push would sail straight through on those repos.
// Single source of truth for both the pre-push hook and the in-code guard in
// publish() (the hook alone is not enough: the publish path pushes with
// --no-verify, which skips pre-push hooks entirely).
export function protectedBranches(repoDir: string): Set<string> {
  return new Set(["main", "master", resolveRemoteDefaultBranch(repoDir)]);
}

// Sync fs here would block the daemon's single event loop long enough to
// miss a health probe (CONTRIBUTING.md rule #4) — use the async variants.
export async function installProtectedBranchHook(
  repoDir: string,
): Promise<void> {
  const hooksDir = join(repoDir, ".git", "hooks");
  await mkdir(hooksDir, { recursive: true });
  await writeFile(join(hooksDir, "pre-push"), HOOK, { encoding: "utf-8" });
  await chmod(join(hooksDir, "pre-push"), 0o755);

  await writeFile(
    join(hooksDir, "protected-branches"),
    `${[...protectedBranches(repoDir)].join("\n")}\n`,
    { encoding: "utf-8" },
  );
}
