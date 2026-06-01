import { createHash } from "node:crypto";
import { sandboxIdKey, type SandboxId } from "../types";

const SLUG_MAX = 24;

/** Stable short hash of a SandboxId. Length in hex chars (default 16). */
export function hashSandboxId(id: SandboxId, length = 16): string {
  return createHash("sha256")
    .update(sandboxIdKey(id))
    .digest("hex")
    .slice(0, length);
}

/**
 * Human-readable URL handle for a sandbox: `<slug>-<hash16>`, where `slug` is
 * derived from the last `/`-segment of the branch and `hash16` is the first
 * 16 hex chars (~64 bits) of `SHA256(userId:projectRef)`. Falls back to a
 * bare hash when the branch is missing or sanitizes to empty.
 *
 * Both live runners expose the handle as a public hostname (agent-sandbox
 * preview URLs; the user-desktop `<handle>.localhost` ingress), so the handle
 * is the only authorization on those URLs — a 64-bit hash resists brute-force
 * at an unrate-limited gateway (a shorter 20-bit hash would fall in ~17 min
 * at 1k req/s).
 *
 * Total max length: 24 + 1 + 16 = 41 chars (under the 63-char DNS label cap
 * with room for a runner-specific prefix).
 */
export function computeHandle(id: SandboxId, branch?: string | null): string {
  const hash = hashSandboxId(id);
  const slug = slugifyBranch(branch);
  return slug ? `${slug}-${hash}` : `s-${hash}`;
}

function slugifyBranch(branch: string | null | undefined): string {
  if (!branch) return "";
  const lastSegment = branch.split("/").pop() ?? "";
  return lastSegment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}
