/**
 * Test-side mirror of the sandbox handle contract.
 *
 * A handle IS the branch, scoped by repository:
 * `<repo scope>/<slugified branch>`. Local and remote names agree, so the
 * handle, the worktree directory and the git branch are one identity — see
 * `compute_handle` in `crates/local-api/src/sandbox/manager.rs`.
 *
 * Kept in ONE place rather than copied into each spec: four separate copies of
 * the previous `(virtualMcpId, branch)` formula all went stale together when
 * the contract changed, and every one of them failed as an opaque string
 * mismatch. If this file and the Rust ever disagree, that is the bug — fix it
 * here, not by loosening the assertion.
 */
import { join } from "node:path";

/** Sandbox workdirs live under this directory of the app root. */
export const WORKTREES_DIR = "worktrees";

/** Mirrors `sanitize` in `sandbox/repo_store.rs`. */
function sanitize(segment: string): string | null {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\")
  ) {
    return null;
  }
  return segment;
}

/** Mirrors `split_remote` in `sandbox/repo_store.rs`. */
function splitRemote(url: string): [string, string] | null {
  const schemeSplit = url.indexOf("://");
  if (schemeSplit !== -1) {
    const scheme = url.slice(0, schemeSplit);
    let rest = url.slice(schemeSplit + 3);
    const at = rest.lastIndexOf("@");
    if (at !== -1) rest = rest.slice(at + 1);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    const host = rest.slice(0, slash);
    const path = rest.slice(slash + 1);
    if (host === "") {
      // `file:///abs/path` has no host: reserved pseudo-host, whole path kept.
      if (scheme.toLowerCase() === "file") return ["local", path];
      return null;
    }
    return [host, path];
  }
  // scp-style `git@host:owner/repo`; a `:` that is really a port is not this.
  const colon = url.indexOf(":");
  if (colon === -1) return null;
  const before = url.slice(0, colon);
  const path = url.slice(colon + 1);
  if (path.startsWith("/") || /^[0-9]/.test(path)) return null;
  const at = before.lastIndexOf("@");
  return [at === -1 ? before : before.slice(at + 1), path];
}

/** Mirrors `repo_scope` in `sandbox/repo_store.rs`. */
function repoScope(cloneUrl: string): string[] | null {
  const trimmed = cloneUrl.trim();
  const split = splitRemote(trimmed);
  if (split === null) {
    // A plain filesystem path is a legitimate remote (every test fixture is
    // one). No host, so it scopes under a reserved `local` segment using the
    // last two path components.
    if (!trimmed.startsWith("/")) return null;
    const stripped = trimmed.endsWith(".git")
      ? trimmed.slice(0, -".git".length)
      : trimmed;
    const tail = stripped
      .split("/")
      .filter((segment) => segment !== "")
      .slice(-2)
      .map(sanitize)
      .filter((segment): segment is string => segment !== null);
    if (tail.length === 0) return null;
    return ["local", ...tail];
  }
  const [host, path] = split;
  const parts = path.split("/").filter((segment) => segment !== "");
  const last = parts.pop();
  if (last === undefined) return null;
  const hostSegment = sanitize(host.toLowerCase());
  if (hostSegment === null) return null;
  const out = [hostSegment];
  for (const segment of parts) {
    const clean = sanitize(segment);
    if (clean === null) return null;
    out.push(clean);
  }
  const repo = last.endsWith(".git") ? last.slice(0, -".git".length) : last;
  const cleanRepo = sanitize(repo);
  if (cleanRepo === null) return null;
  out.push(cleanRepo);
  return out;
}

/** Mirrors `slugify_branch` in `sandbox/manager.rs`. */
export function slugifyBranch(branch: string): string {
  const MAX_LEN = 40;
  let out = "";
  let lastDash = false;
  for (const ch of branch) {
    const lower = ch.toLowerCase();
    if (/[a-z0-9]/.test(lower)) {
      out += lower;
      lastDash = false;
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  const clipped = out
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LEN)
    .replace(/-+$/, "");
  return clipped === "" ? "branch" : clipped;
}

/** Mirrors `compute_handle` in `sandbox/manager.rs`. */
export function computeHandle(cloneUrl: string, branch: string): string {
  const scope = repoScope(cloneUrl);
  if (scope === null) {
    throw new Error(`no repo scope for clone url ${cloneUrl}`);
  }
  return [...scope, slugifyBranch(branch)].join("/");
}

/** A handle's workdir under an app root. Handles nest — they contain `/`. */
export function sandboxDirFor(appRoot: string, handle: string): string {
  return join(appRoot, WORKTREES_DIR, ...handle.split("/"));
}

/** The checkout directory for a handle, under an app root. */
export function repoDirFor(appRoot: string, handle: string): string {
  return join(sandboxDirFor(appRoot, handle), "repo");
}
