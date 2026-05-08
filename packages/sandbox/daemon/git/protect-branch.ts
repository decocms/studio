import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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

export function installProtectedBranchHook(repoDir: string): void {
  const hooksDir = join(repoDir, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-push");
  writeFileSync(hookPath, HOOK, { encoding: "utf-8" });
  chmodSync(hookPath, 0o755);
}
