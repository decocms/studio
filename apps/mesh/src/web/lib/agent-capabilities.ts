import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import type { CurrentLink } from "@/web/hooks/use-current-link";
import { getActiveGithubRepo } from "./github-repo";

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
 * Built on top of `getActiveGithubRepo`, which already returns null
 * when a stale connectionId references a detached connection.
 */
export function agentHasConnectedGithub(
  virtualMcp: VirtualMCPEntity | null | undefined,
): boolean {
  return !!getActiveGithubRepo(virtualMcp ?? null)?.connectionId;
}

/**
 * The top-right GitHub header actions operate on GitHub PR/check/review state,
 * so they require an authenticated, attached GitHub connection. Public template
 * clones are clonable sources, but they are not GitHub-linked projects.
 */
export function agentShowsGithubHeaderActions(
  virtualMcp: VirtualMCPEntity | null | undefined,
): boolean {
  return agentHasConnectedGithub(virtualMcp);
}

/**
 * The set of agent ids that are linked as some agent's dev agent
 * (`metadata.devAgentId`). These are hidden from the sidebar — they're
 * reached via the Develop/Live toggle on their live counterpart, not as
 * standalone entries.
 */
export function getDevAgentIds(
  agents: VirtualMCPEntity[] | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const a of agents ?? []) {
    const devId = a.metadata?.devAgentId;
    if (typeof devId === "string" && devId) ids.add(devId);
  }
  return ids;
}

/**
 * Live↔dev agent id maps derived from `metadata.devAgentId`:
 * - `liveToDev`: live agent id → its dev agent id (the Develop toggle target).
 * - `devToLive`: dev agent id → its live agent id (parent).
 * Used to fold a dev agent's sidebar thread group into its live counterpart.
 */
export function getLiveDevAgentMaps(
  agents: VirtualMCPEntity[] | null | undefined,
): { liveToDev: Map<string, string>; devToLive: Map<string, string> } {
  const liveToDev = new Map<string, string>();
  const devToLive = new Map<string, string>();
  for (const a of agents ?? []) {
    const devId = a.metadata?.devAgentId;
    if (typeof devId === "string" && devId) {
      liveToDev.set(a.id, devId);
      devToLive.set(devId, a.id);
    }
  }
  return { liveToDev, devToLive };
}

/**
 * Resolve the Develop/Live partner of an agent from the loaded agent list.
 * - `mode: "live"` when this agent links a dev agent (`metadata.devAgentId`).
 * - `mode: "dev"` when this agent IS some agent's dev agent (reverse lookup).
 * - `null` when the agent is not part of a dev/live pair.
 * `targetId` is the OTHER agent in the pair — where the toggle navigates.
 */
export function findDevPartner(
  agent: VirtualMCPEntity | null | undefined,
  agents: VirtualMCPEntity[] | null | undefined,
): { mode: "live" | "dev"; targetId: string } | null {
  if (!agent) return null;
  const devId = agent.metadata?.devAgentId;
  if (typeof devId === "string" && devId) {
    return { mode: "live", targetId: devId };
  }
  const parent = (agents ?? []).find(
    (a) => a.metadata?.devAgentId === agent.id,
  );
  return parent ? { mode: "dev", targetId: parent.id } : null;
}

/**
 * True when the user's link daemon is online AND exposes at least one
 * CLI harness (Claude Code or Codex) that a clonable agent's chat can
 * route through. Lets the chat skip the no-provider empty state when
 * the user has a local CLI to fall back on.
 */
export function hasLocalCliHarness(link: CurrentLink): boolean {
  if (!link.online) return false;
  return (
    link.capabilities.includes("claude-code") ||
    link.capabilities.includes("codex")
  );
}
