/**
 * Whether a chat turn saved the store goal. Organization settings have no push
 * path, so the chat refetches them after a turn that wrote the goal and the
 * Plan page shows it without a reload.
 *
 * A static tool part is `tool-<name>`; a dynamic one carries `toolName`, which
 * a sandbox-hosted run prefixes (`mcp__<server>__<name>`), hence the suffix.
 */

const GOAL_TOOL = "ORGANIZATION_PLAN_OBJECTIVE_SET";

export function savedStoreGoal(
  parts: readonly { type: string; state?: string; toolName?: unknown }[],
): boolean {
  return parts.some((part) => {
    if (part.state !== "output-available") return false;
    const name =
      typeof part.toolName === "string"
        ? part.toolName
        : part.type.startsWith("tool-")
          ? part.type.slice("tool-".length)
          : "";
    return name === GOAL_TOOL || name.endsWith(`__${GOAL_TOOL}`);
  });
}
