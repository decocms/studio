/**
 * Builds the <available-agents> system-prompt block.
 *
 * Each /decopilot/stream request runs inside a single Virtual MCP. This
 * catalog advertises the *other* active Virtual MCPs in the organization
 * so the model can delegate cross-agent work via the subtask tool.
 *
 * Encoded as RFC 4180 CSV (header row + one row per agent) to keep the
 * prompt compact. The block is stable per organization so the prompt
 * prefix can be cached across steps.
 */

const DESCRIPTION_MAX_LEN = 140;

export interface AgentCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "inactive" | "error";
}

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

export function buildAgentCatalog(
  virtualMcps: AgentCatalogEntry[],
  currentVirtualMcpId: string,
): string | null {
  const others = virtualMcps.filter(
    (vm) => vm.id !== currentVirtualMcpId && vm.status === "active",
  );
  if (others.length === 0) return null;

  const rows = others.map((vm) => {
    const desc = truncate(vm.description ?? "", DESCRIPTION_MAX_LEN);
    return `${csvField(vm.id)},${csvField(vm.name)},${csvField(desc)}`;
  });

  return `\n\n<available-agents>\nid,name,description\n${rows.join("\n")}\n</available-agents>`;
}
