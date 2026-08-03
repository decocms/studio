import { existsSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_CWD_REPO, type HarnessCwd } from "./workspace-cwd";

/**
 * Local-fs probe: does the attached sandbox checkout contain a `.deco/`
 * directory? Used by the CLI harnesses (claude-code, codex), which run INSIDE
 * the sandbox — the repo checkout is on the local filesystem, so a synchronous
 * `existsSync` is cheap and correct. `.deco/` is the marker of a Deco CMS site;
 * its presence gates the CMS-content rules block (see `DECO_CMS_CONTENT_RULES`
 * in `coding-workspace-prompt.ts`).
 *
 * `cwd` is the symbolic wire value ("/repo" | null). No checkout (`null`) is
 * never a deco site. For "/repo" we probe two bases because the real checkout
 * location differs by sandbox kind: hosted containers mount it literally at
 * `/repo`, while the desktop daemon runs the harness with the checkout as
 * `process.cwd()` (it rebases the symbolic "/repo" onto its own sandbox root).
 */
export function localWorkspaceIsDecoSite(cwd: HarnessCwd): boolean {
  if (!cwd) return false;
  const bases =
    cwd === WORKSPACE_CWD_REPO ? [process.cwd(), WORKSPACE_CWD_REPO] : [cwd];
  return bases.some((base) => {
    try {
      return existsSync(join(base, ".deco"));
    } catch {
      return false;
    }
  });
}
