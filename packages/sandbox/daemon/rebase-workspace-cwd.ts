/**
 * Rebase the wire's SYMBOLIC workspace.cwd onto this daemon's sandbox root
 * (spec decision Q4: containment by construction — the cluster never dictates
 * a host-absolute path on a user machine).
 *
 * The sentinel value "default" is the same as `WORKSPACE_CWD_DEFAULT` in
 * `apps/mesh/src/harnesses/workspace-cwd.ts`. It is re-declared here rather
 * than imported across the packages→apps boundary — same convention as the
 * rest of the daemon graph.
 */
import { resolve, sep } from "node:path";

const WORKSPACE_CWD_DEFAULT = "default";

export function rebaseWorkspaceCwd(cwd: string, appRoot: string): string {
  if (cwd === WORKSPACE_CWD_DEFAULT) return cwd;
  const root = resolve(appRoot);
  const rebased = resolve(root, "." + sep + cwd.replace(/^[/\\]+/, ""));
  if (rebased !== root && !rebased.startsWith(root + sep)) {
    // Escape attempt or malformed value — fall back, never fail (Q5).
    return WORKSPACE_CWD_DEFAULT;
  }
  return rebased;
}

export function daemonAppRoot(): string {
  return process.env.WORKDIR || process.env.APP_ROOT || process.cwd();
}
