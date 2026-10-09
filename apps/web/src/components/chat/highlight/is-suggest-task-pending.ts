/**
 * A `suggest_task` offer still waiting for the user. Decopilot's client-side
 * tool waits in `input-available`; the Studio MCP tool returns at once, so its
 * offer waits until the user's answer stores a boolean `accepted`.
 */
export function isSuggestTaskPending(part: {
  type: string;
  state?: string;
  output?: unknown;
}): boolean {
  if (part.type !== "tool-suggest_task") return false;
  if (part.state === "input-available") return true;
  const output = part.output as { accepted?: unknown } | null | undefined;
  return (
    part.state === "output-available" && typeof output?.accepted !== "boolean"
  );
}
