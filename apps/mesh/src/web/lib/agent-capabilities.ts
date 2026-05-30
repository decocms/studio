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
