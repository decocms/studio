/**
 * Rebase the wire's SYMBOLIC workspace.cwd onto this daemon's sandbox root
 * (spec decision Q4: containment by construction — the cluster never dictates
 * a host-absolute path on a user machine).
 */
import { resolve, sep } from "node:path";

export type WireWorkspaceCwd = "/repo" | null;

export function rebaseWorkspaceCwd(
  cwd: WireWorkspaceCwd,
  appRoot: string,
): string | null {
  if (cwd === null) return null;
  if (cwd !== "/repo") return null;
  const root = resolve(appRoot);
  const rebased = resolve(root, "." + sep + cwd.replace(/^[/\\]+/, ""));
  if (rebased !== root && !rebased.startsWith(root + sep)) {
    return null;
  }
  return rebased;
}

export function daemonAppRoot(): string {
  return process.env.WORKDIR || process.env.APP_ROOT || process.cwd();
}
