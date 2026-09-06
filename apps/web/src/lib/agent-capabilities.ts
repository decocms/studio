import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { resolveGithubAttachment } from "./github-repo";

/**
 * True when the agent has source code we can check out into a per-branch
 * sandbox. Both Start Website agents (clone from a public template) and
 * GitHub-imported agents (clone the user's repo) populate
 * `metadata.githubRepo.url`. Decopilot-only agents have neither, so this
 * returns false and they fall back to the cloud Decopilot harness.
 *
 * Kept loosely-typed (accepts `unknown`) because the metadata field
 * isn't centrally schematized — different creators add different keys
 * and a strict type wouldn't help here.
 */
export function agentHasClonableSource(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false;
  const meta = metadata as { githubRepo?: { url?: unknown } | null };
  const url = meta.githubRepo?.url;
  return typeof url === "string" && url.length > 0;
}

/**
 * True only when the virtual MCP has a GitHub repo with an attached
 * connection (i.e. authenticated github identity, not a public-clone
 * template). Gate the git tab on this predicate.
 *
 * A `detached` repo (connection removed) is deliberately NOT connected here:
 * the git tab has nothing to operate on until the user reconnects.
 */
export function agentHasConnectedGithub(
  virtualMcp: VirtualMCPEntity | null | undefined,
): boolean {
  return resolveGithubAttachment(virtualMcp).status === "attached";
}

/**
 * The top-right GitHub header actions operate on GitHub PR/check/review state,
 * so they require a GitHub-linked project. Public template clones are clonable
 * sources but not GitHub-linked, so they get no header. A `detached` repo still
 * shows the header — as a reconnect affordance — rather than silently vanishing.
 */
export function agentShowsGithubHeaderActions(
  virtualMcp: VirtualMCPEntity | null | undefined,
): boolean {
  const status = resolveGithubAttachment(virtualMcp).status;
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
 */
export function findDevPartner(
  agent: VirtualMCPEntity | null | undefined,
  agents: VirtualMCPEntity[] | null | undefined,
): { mode: "live" | "dev"; targetId: string } | null {
  if (!agent) return null;
  const liveId = agent.metadata?.liveAgentId;
  if (typeof liveId === "string" && liveId) {
    return { mode: "dev", targetId: liveId };
  }
  const devAgent = (agents ?? []).find(
    (a) => a.metadata?.liveAgentId === agent.id,
  );
  return devAgent ? { mode: "live", targetId: devAgent.id } : null;
}
