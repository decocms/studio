import type { SandboxMap } from "@decocms/shared/sdk/types";

/**
 * Raw sandboxMap keys that mean "agent-sandbox". `cluster` is the legacy
 * spelling — `parseBranchMap` normalizes it, so filtering only `agent-sandbox`
 * would let a legacy cell through and reintroduce the bug this guards against.
 */
const AGENT_SANDBOX_KEYS = new Set(["agent-sandbox", "cluster"]);

/**
 * Drop `agent-sandbox` entries from a virtual MCP's `metadata.sandboxMap`.
 *
 * The agent row is NOT authoritative for that kind: the server resolves
 * agent-sandbox exclusively from the org-scoped session registry
 * (`agent_sandbox_sessions`) and deliberately ignores what sits in sandboxMap —
 * see `readRecordedKinds` in `apps/api/src/sandbox/resolve-provider.ts`. Nothing
 * writes agent-sandbox there anymore either (`SANDBOX_START` only calls
 * `setSandboxMapEntry` for non-shared kinds), so every such entry is a leftover
 * from before the kind became org-shared.
 *
 * Trusting them client-side is what strands a preview: the leftover entry makes
 * `vmEntry` non-null for whichever user key happens to hold it, `shouldAutoStart`
 * then returns false, and no `SANDBOX_START` is ever issued — while `previewUrl`
 * points at a reaped sandbox, so there is nothing to self-heal from either. A
 * teammate whose key is absent from the same map sails through and provisions
 * normally, which is why this reads as "works for me, stuck for you".
 *
 * Behaviour-neutral otherwise: when a session row does exist, its graft in
 * `VmEventsBridge` already overwrites the entry this strips.
 *
 * Returns the input reference unchanged when there is nothing to strip.
 */
export function withoutLegacyAgentSandboxEntries(
  sandboxMap: SandboxMap | undefined,
): SandboxMap | undefined {
  if (!sandboxMap) return sandboxMap;
  let changed = false;
  const next: SandboxMap = {};
  for (const [userId, byBranch] of Object.entries(sandboxMap)) {
    const nextByBranch: SandboxMap[string] = {};
    for (const [branch, cell] of Object.entries(byBranch ?? {})) {
      const kinds = Object.entries(cell ?? {});
      const kept = kinds.filter(([kind]) => !AGENT_SANDBOX_KEYS.has(kind));
      if (kept.length !== kinds.length) changed = true;
      if (kept.length > 0) nextByBranch[branch] = Object.fromEntries(kept);
    }
    if (Object.keys(nextByBranch).length > 0) next[userId] = nextByBranch;
  }
  return changed ? next : sandboxMap;
}
