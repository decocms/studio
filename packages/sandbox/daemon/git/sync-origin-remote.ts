import { gitSync } from "./git-sync";

export function cloneUrlHasCredentials(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username.length > 0 || u.password.length > 0;
  } catch {
    return false;
  }
}

/** Point `origin` at the credentialed clone URL from daemon config. */
export function syncOriginRemote(repoDir: string, cloneUrl: string): void {
  if (!cloneUrlHasCredentials(cloneUrl)) return;
  gitSync(["remote", "set-url", "origin", cloneUrl], { cwd: repoDir });
}
