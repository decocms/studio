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
