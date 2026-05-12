/**
 * Builds the <available-agents> + <agents-usage> system-prompt block.
 *
 * Each /decopilot/stream request runs inside a single Virtual MCP. This
 * block advertises the *other* active Virtual MCPs in the organization
 * so the model can delegate cross-agent work via the subtask tool.
 *
 * Returns null when no other active agent exists so the block — and the
 * subtask delegation guidance — drops out of the prompt entirely.
 *
 * The block is stable per organization so the prompt prefix can be
 * cached across steps.
 */

const DESCRIPTION_MAX_LEN = 140;

export interface AgentsBlockEntry {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "inactive" | "error";
}

const USAGE = `<agents-usage>
Other agents have their own tools and instructions. Delegate self-contained
work with subtask({ agent_id, prompt }). Include full context in the prompt —
subagents have no conversation history.
</agents-usage>`;

function csvField(s: string | null | undefined): string {
  if (s == null || s === "") return "";
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function buildAgentsBlock(
  agents: AgentsBlockEntry[],
  currentVirtualMcpId: string,
): string | null {
  const others = agents.filter(
    (a) => a.id !== currentVirtualMcpId && a.status === "active",
  );
  if (others.length === 0) return null;

  const rows = others.map((a) => {
    const desc = truncate(a.description ?? "", DESCRIPTION_MAX_LEN);
    return `${csvField(a.id)},${csvField(a.name)},${csvField(desc)}`;
  });

  return (
    `\n\n<available-agents>\nid,name,description\n${rows.join("\n")}\n</available-agents>` +
    `\n\n${USAGE}`
  );
}
