/**
 * Single source of truth for `projectRef`. Two opaque encodings:
 *   `agent:<orgId>:<virtualMcpId>:<branch>` — agent-thread sandboxes.
 *   `thread:<threadId>` — ad-hoc sandboxes.
 * Runners never parse the ref; they hash it for their routing key.
 */

export type AgentSandboxRefInput = {
  orgId: string;
  virtualMcpId: string;
  branch: string;
};

export type ThreadSandboxRefInput = { threadId: string };

export type SandboxRefInput = AgentSandboxRefInput | ThreadSandboxRefInput;

export function composeSandboxRef(input: SandboxRefInput): string {
  if ("threadId" in input) {
    if (!input.threadId)
      throw new Error("composeSandboxRef: threadId required");
    return `thread:${input.threadId}`;
  }
  if (!input.orgId || !input.virtualMcpId || !input.branch) {
    throw new Error(
      "composeSandboxRef: orgId, virtualMcpId and branch are all required for agent refs",
    );
  }
  return `agent:${input.orgId}:${input.virtualMcpId}:${input.branch}`;
}

/**
 * The human-readable part of a ref, used as the handle's slug source: the
 * branch for `agent:` refs, the threadId for `thread:` refs.
 *
 * Exists so `computeHandle` derives its slug from the SAME value it hashes.
 * When the slug came from a separate `branch` argument the two could disagree,
 * and since the claim name IS the dedupe key that produced two claims and two
 * pods for one logical sandbox — observed in prod 2026-08-04, where
 * `thread:<id>/<conn>` and its derived git ref `sandbox/thread-<id>-<conn>`
 * hashed identically but slugged differently.
 *
 * Returns "" for a ref in neither encoding (legacy/test callers); the caller
 * falls back to a bare hash.
 */
export function refSlugSource(projectRef: string): string {
  if (projectRef.startsWith("thread:"))
    return projectRef.slice("thread:".length);
  if (!projectRef.startsWith("agent:")) return "";
  // agent:<orgId>:<vmcpId>:<branch> — the branch itself may contain ":" (a
  // thread-scoped branch is `thread:<threadId>/<connId>`), so keep every
  // segment past the third.
  const parts = projectRef.split(":");
  return parts.length >= 4 ? parts.slice(3).join(":") : "";
}
