import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { resolveRepositoryAttachment } from "./repository-binding";

/**
 * True when the agent has source code we can check out into a per-branch
 * sandbox. Both Start Website agents (clone from a public template) and
 * Repository-imported agents (clone the user's repo) populate
 * `metadata.repository.url`. Decopilot-only agents have neither, so this
 * returns false and they fall back to the cloud Decopilot harness.
 *
 * Kept loosely-typed (accepts `unknown`) because the metadata field
 * isn't centrally schematized — different creators add different keys
 * and a strict type wouldn't help here.
 */
export function agentHasClonableSource(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false;
  const meta = metadata as { repository?: { url?: unknown } | null };
  const url = meta.repository?.url;
  return typeof url === "string" && url.length > 0;
}

/** A repository must have an attached credential source to expose git actions. */
export function agentHasConnectedRepository(
  virtualMcp: VirtualMCPEntity | null | undefined,
): boolean {
  return resolveRepositoryAttachment(virtualMcp).status === "attached";
}

/** Detached bindings keep the header visible so the user can reconnect. */
export function agentShowsRepositoryHeaderActions(
  virtualMcp: VirtualMCPEntity | null | undefined,
): boolean {
  const status = resolveRepositoryAttachment(virtualMcp).status;
  return status === "attached" || status === "detached";
}

/**
 * The set of agent ids that are dev agents — they develop a live counterpart
 * (`metadata.liveAgentId` is set). Hidden from the sidebar/pickers; reached via
 * the Develop/Live toggle on their live counterpart, not as standalone entries.
 *
 * The pairing ref lives on the dev agent (not the live one) so "is this a dev
 * agent?" is a local field — cheap both here and on the server hot path, where
 * it gates ephemeral dev-connection injection without a reverse lookup.
 */
export function getDevAgentIds(
  agents: VirtualMCPEntity[] | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const a of agents ?? []) {
    const liveId = a.metadata?.liveAgentId;
    if (typeof liveId === "string" && liveId) ids.add(a.id);
  }
  return ids;
}

/**
 * Resolve the Develop/Live partner of an agent from the loaded agent list.
 * - `mode: "dev"` when this agent IS a dev agent (`metadata.liveAgentId` set) —
 *   the partner is its live counterpart.
 * - `mode: "live"` when some dev agent develops this one (reverse lookup over
 *   the loaded list) — the partner is that dev agent.
 * - `null` when the agent is not part of a dev/live pair.
 * `targetId` is the OTHER agent in the pair — where the toggle navigates.
 *
 * Both directions are checked against `agents`: deleting a virtual MCP does
 * not clear `liveAgentId` on the counterpart it leaves behind, so a dev agent
 * can carry a `liveAgentId` pointing at an agent that no longer exists. Left
 * unchecked, the toggle would still render and navigate to a dead id.
 */
export function findDevPartner(
  agent: VirtualMCPEntity | null | undefined,
  agents: VirtualMCPEntity[] | null | undefined,
): { mode: "live" | "dev"; targetId: string } | null {
  if (!agent) return null;
  const liveId = agent.metadata?.liveAgentId;
  if (typeof liveId === "string" && liveId) {
    const liveAgent = (agents ?? []).find((a) => a.id === liveId);
    return liveAgent ? { mode: "dev", targetId: liveId } : null;
  }
  const devAgent = (agents ?? []).find(
    (a) => a.metadata?.liveAgentId === agent.id,
  );
  return devAgent ? { mode: "live", targetId: devAgent.id } : null;
}
