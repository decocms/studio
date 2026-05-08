import { gitSync, type GitSyncOpts } from "../git/git-sync";

export function git(args: string[], opts: GitSyncOpts): string {
  return gitSync(["-c", "safe.directory=*", ...args], opts);
}
