import { createHash } from "node:crypto";
import { sandboxIdKey, type SandboxId } from "../types";

const SLUG_MAX = 24;
const DEFAULT_HASH_LEN = 5;

/** Stable short hash of a SandboxId. Length in hex chars (default 16). */
export function hashSandboxId(id: SandboxId, length = 16): string {
  return createHash("sha256")
    .update(sandboxIdKey(id))
    .digest("hex")
    .slice(0, length);
}

/**
 * Human-readable URL handle for a sandbox: `<slug>-<hashN>`, where `slug` is
 * derived from the last `/`-segment of the branch and `hashN` is the first
 * `N` hex chars of `SHA256(userId:projectRef)`. Falls back to a bare hash
 * when the branch is missing or sanitizes to empty.
 *
 * Hash length defaults to 5 chars (~20 bits) — sufficient for runners whose
 * handle is local (Docker container name, Freestyle internal ID). Runners
 * that expose the handle as a public hostname (agent-sandbox preview URLs,
 * Vercel-style) should pass `{ hashLen: 16 }` (~64 bits) — the handle is
 * the only authorization on those URLs, so brute-forcing 20 bits at an
 * unrate-limited gateway (~17 min at 1k req/s) is meaningfully easier
 * than 64 bits.
 *
 * Total max length: 24 + 1 + hashLen chars. With hashLen=16: 41 chars
 * (under the 63-char DNS label cap with room for a runner-specific
 * prefix).
 */
export function computeHandle(
  id: SandboxId,
  branch?: string | null,
  opts: { hashLen?: number } = {},
): string {
  const hashLen = opts.hashLen ?? DEFAULT_HASH_LEN;
  const hash = hashSandboxId(id, hashLen);
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
